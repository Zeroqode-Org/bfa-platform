import { z } from "zod";

import { ASSET_FIELD_LIMITS } from "./asset-field-limits";
import { CUSTOMER_FIELD_LIMITS } from "./customer-field-limits";

/**
 * Input shapes for the customer procedures.
 *
 * They live here rather than inline in the router so the validation rules can
 * be exercised without a database connection — `routers/customers.ts` imports
 * `@bfa-platform/db`, and importing that to assert that a blank name is
 * rejected would make a pure rule need a Postgres.
 *
 * `water_purveyor_id` is deliberately absent from every shape below. The
 * caller's tenant comes from their own profile in `wpProcedure`; a client that
 * sends one is sending a field the server does not read.
 */

/**
 * Optional free text. A form that has been typed into and cleared sends `""`,
 * not `undefined`, and storing that would give the column two spellings of
 * "empty" — so blank collapses to NULL here rather than in each caller.
 */
function optionalText(max: number) {
	return z
		.string()
		.trim()
		.max(max)
		.nullish()
		.transform((value) => value || null);
}

const customerFields = {
	// Trimmed before the length check, so a name of nothing but spaces is empty
	// rather than valid.
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(CUSTOMER_FIELD_LIMITS.name),
	// Normalised the same way invitations are: a pasted address with a stray
	// space or a capitalised domain is accepted, and one address has one
	// spelling in the table.
	email: z
		.string()
		.trim()
		.toLowerCase()
		.pipe(z.email().max(CUSTOMER_FIELD_LIMITS.email)),
	accountNumber: optionalText(CUSTOMER_FIELD_LIMITS.accountNumber),
	// Required: the address is what the notices are written about, and a
	// customer record without one is incomplete (WP/Admin feedback). The column
	// stays nullable — rows saved before the rule keep reading — but no save
	// through here can leave it blank, so editing such a row means filling it.
	address: z
		.string()
		.trim()
		.min(1, "Address is required")
		.max(CUSTOMER_FIELD_LIMITS.address),
	status: z.enum(["active", "suspended"]).default("active"),
	/**
	 * The BIN of an asset to attach this customer to — not a column. Saving it
	 * makes the customer that asset's current occupant, through the same writes
	 * as `assets.assignCustomer`; see `customer-bin.ts` for the rule.
	 *
	 * Optional at the shape level because whether one is needed depends on the
	 * row: a new customer always needs one, an existing customer only while they
	 * hold no asset. The procedures decide that, with one message for both.
	 */
	attachBin: optionalText(ASSET_FIELD_LIMITS.bin),
	/**
	 * The caller has seen that the BIN belongs to another occupant and wants it
	 * moved anyway. Without it, such a save is refused with the question.
	 */
	acknowledgeReassign: z.boolean().optional(),
};

/**
 * Standard rate. The renewal date is an agricultural-only field, so a value
 * here is refused rather than ignored — a request carrying one is confused
 * about what it is asking for, and silently dropping it would leave the client
 * believing a date was stored.
 *
 * Explicit `null` is accepted, because that is what the edit form sends when a
 * customer moves off the agricultural rate, and the write always stores NULL.
 */
const standardCustomer = z.object({
	...customerFields,
	rateCategory: z.literal("standard"),
	agRenewalDate: z
		.null()
		.optional()
		.describe("Not allowed on the standard rate"),
});

/**
 * Agricultural rate. The renewal date is what the AG renewal notice fires
 * against, so a customer on this rate without one is a notice that can never be
 * scheduled — required here rather than left to the workflow to discover.
 */
const agriculturalCustomer = z.object({
	...customerFields,
	rateCategory: z.literal("agricultural"),
	agRenewalDate: z.iso.date("An AG renewal date is required"),
});

export const createCustomerInput = z.discriminatedUnion("rateCategory", [
	standardCustomer,
	agriculturalCustomer,
]);

/**
 * The update shape is the create shape plus the row's id and the revision the
 * editor started from — every field is sent, so the form is the whole record
 * and a field left out of a request is a field genuinely being cleared, not
 * one being kept.
 *
 * `expectedRevision` is what makes "the whole record" safe to send. The AG
 * renewal notice moves `ag_renewal_date` on a year by itself after a delivery,
 * so a form opened before that and saved after it would otherwise put the old
 * date back and queue a second email. Required rather than optional: a caller
 * that does not know which version it is editing cannot be allowed to
 * overwrite one.
 */
const editedRecord = {
	id: z.uuid(),
	expectedRevision: z
		.int()
		.positive("The customer revision must be a positive whole number"),
};

export const updateCustomerInput = z.discriminatedUnion("rateCategory", [
	standardCustomer.extend(editedRecord),
	agriculturalCustomer.extend(editedRecord),
]);

export type CreateCustomerInput = z.infer<typeof createCustomerInput>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerInput>;

/**
 * The column values a validated input writes.
 *
 * Both rate categories go through here so the renewal date has exactly one
 * rule: it is stored for an agricultural customer and NULL for a standard one.
 * The alternative — trusting the input's own `agRenewalDate` — would leave a
 * stale date on the row of a customer who moved back to the standard rate.
 */
export function customerColumns(input: CreateCustomerInput) {
	return {
		name: input.name,
		email: input.email,
		accountNumber: input.accountNumber,
		address: input.address,
		rateCategory: input.rateCategory,
		agRenewalDate:
			input.rateCategory === "agricultural" ? input.agRenewalDate : null,
		status: input.status,
	};
}
