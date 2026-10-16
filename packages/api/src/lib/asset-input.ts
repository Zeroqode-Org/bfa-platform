import { z } from "zod";

import { ASSET_FIELD_LIMITS } from "./asset-field-limits";

/**
 * Input shapes for the BFA-asset procedures.
 *
 * They live here rather than inline in the router so the validation rules can
 * be exercised without a database connection — `routers/assets.ts` imports
 * `@bfa-platform/db`, and importing that to assert that a blank BIN is rejected
 * would make a pure rule need a Postgres.
 *
 * Two fields are deliberately absent from every shape below.
 * `water_purveyor_id`, because the caller's tenant comes from their own profile
 * in `wpProcedure` — a client that sends one is sending a field the server does
 * not read. And `asset_status`, because the scheduler recomputes it from
 * `annual_test_date`; it is a derived value, not an answer to a question a
 * person was asked.
 */

/** The eight assembly types the wizard and the results documents cover. */
export const BFA_TYPES = [
	"RP",
	"RPDA",
	"RPDA-2",
	"DC",
	"DCDA",
	"DCDA-2",
	"PVB",
	"SVB",
] as const;

/** The three states the scheduler computes from the annual test date. */
export const ASSET_STATUSES = ["active", "due_soon", "past_due"] as const;

/**
 * Required free text. Trimmed before the length check, so a value of nothing
 * but spaces is empty rather than valid.
 */
function requiredText(message: string, max: number) {
	return z.string().trim().min(1, message).max(max);
}

const assetFields = {
	/**
	 * The BIN. Unique per purveyor (`bfa_assets_water_purveyor_id_bin_key`), and
	 * the value every notice, submission and wizard prefill is keyed on.
	 * Trimmed before the length check, so a BIN of nothing but spaces is empty
	 * rather than valid.
	 */
	bin: z
		.string()
		.trim()
		.min(1, "A BIN is required")
		.max(ASSET_FIELD_LIMITS.bin),
	bfaType: z.enum(BFA_TYPES),
	serviceAddress: z
		.string()
		.trim()
		.min(1, "A service address is required")
		.max(ASSET_FIELD_LIMITS.serviceAddress),
	// The assembly's description is required (WP/Admin feedback): these are the
	// details a certifier checks the valve against in the field. The columns
	// stay nullable — certifier-built and older rows keep reading — but no WP
	// save through here can leave one blank, so editing such a row means
	// filling it in.
	make: requiredText("A make is required", ASSET_FIELD_LIMITS.make),
	model: requiredText("A model is required", ASSET_FIELD_LIMITS.model),
	serialNumber: requiredText(
		"A serial number is required",
		ASSET_FIELD_LIMITS.serialNumber,
	),
	size: requiredText("A size is required", ASSET_FIELD_LIMITS.size),
	assemblyLocation: requiredText(
		"An assembly location is required",
		ASSET_FIELD_LIMITS.assemblyLocation,
	),
	/**
	 * Required, not optional, even though the column is nullable.
	 *
	 * The client's confirmed answer is that the annual test date is set by the WP
	 * *at the moment they assign the BIN* — it is what Workflow 1 schedules the
	 * reminder and the three late notices against. Every asset created here is
	 * created with a BIN, so an asset without a date would be one that can never
	 * be reminded about, discovered months later by a notice that never fired.
	 * The column stays nullable for rows that reach the table another way.
	 */
	annualTestDate: z.iso.date("An annual test date is required"),
};

/** The columns both mutations write, without the fields only one of them takes. */
const assetFieldsInput = z.object(assetFields);

/**
 * Creating an asset may also name its first occupant.
 *
 * This is the one place a customer travels with the asset fields, and it is
 * safe here for a reason that does not hold on the edit form: a brand-new asset
 * has no occupancy to close, so attaching one is opening the first
 * `customer_assignments` row rather than replacing an existing one. The
 * procedure still does both writes in a single transaction, so an asset never
 * exists pointing at a customer with no record of when that started.
 *
 * Optional, and `null` is a real answer: an asset registered before its
 * occupant is known is normal, and the customer can be attached later from the
 * asset's own page.
 *
 * The add-asset form no longer offers this (WP/Admin feedback): a customer now
 * reaches an asset from the customer form, by BIN. The procedure keeps the
 * parameter because registering an asset with its occupant in one transaction
 * is still a sound operation — the notice-workflow suites build on it.
 */
export const createAssetInput = assetFieldsInput.extend({
	currentCustomerId: z
		.uuid()
		.nullish()
		.transform((value) => value ?? null),
});

/**
 * The update shape is the create shape plus the row's id — every field is sent,
 * so the form is the whole record and a field left out of a request is a field
 * genuinely being cleared, not one being kept.
 *
 * The BIN is in here. A WP may correct any data it owns, the BIN included
 * ([confirmed decision]); what the procedure adds is that the correction is
 * logged with both values, so "allowed" never becomes "casual".
 *
 * `currentCustomerId` is deliberately *not* in here. On an existing asset,
 * moving the pointer has to close the outgoing occupancy row in the same
 * transaction — a field on this form would be the one way to change an occupant
 * without recording it. `assignCustomer` owns that.
 */
export const updateAssetInput = assetFieldsInput.extend({ id: z.uuid() });

/**
 * The asset list. Page-based rather than cursor-based: the screen shows a
 * numbered pager over a WP's own assets, which is a set measured in hundreds,
 * and a page number is what the person actually asks for.
 *
 * `search` matches a BIN or a service address — the two things somebody
 * standing at a valve knows. Blank collapses to `undefined` so an empty search
 * box is no filter rather than a match on `""`.
 */
export const listAssetsInput = z
	.object({
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(25),
		status: z.enum(ASSET_STATUSES).optional(),
		search: z
			.string()
			.trim()
			.max(200)
			.optional()
			.transform((value) => value || undefined),
	})
	// `prefault`, not `default`: an absent input is parsed as `{}` and picks up
	// each field's own default, rather than needing the whole output object
	// restated here where it could drift from the fields above.
	.prefault({});

export const assetIdInput = z.object({ id: z.uuid() });

/**
 * Attaching a customer to an asset. Both ids are checked against the caller's
 * own purveyor in the procedure — this shape only says that two uuids arrived.
 *
 * `acknowledgeSuspendedCustomer` is the server's half of the screen's
 * confirmation. Attaching a suspended customer stops this asset's automated
 * email entirely, so it may not happen by accident: without this flag the
 * procedure refuses, and the request has to come back saying the consequence
 * was understood. Defaulting it to `false` is the point — a client that has
 * never heard of the flag gets the refusal, not the silent stop.
 */
export const assignCustomerInput = z.object({
	assetId: z.uuid(),
	customerId: z.uuid(),
	acknowledgeSuspendedCustomer: z.boolean().default(false),
});

export type AssetFieldsInput = z.infer<typeof assetFieldsInput>;
export type CreateAssetInput = z.infer<typeof createAssetInput>;
export type UpdateAssetInput = z.infer<typeof updateAssetInput>;
export type ListAssetsInput = z.infer<typeof listAssetsInput>;

/**
 * The column values a validated input writes.
 *
 * Both mutations go through here so the write set has exactly one definition.
 * `asset_status` and `current_customer_id` are not in it: the first belongs to
 * the scheduler, the second is written only alongside the occupancy row that
 * records it — by `assignCustomer`, or by `createAsset` when the new asset
 * names its first occupant. Letting these columns move the pointer on their own
 * would be the one way to change an occupant without recording it.
 */
export function assetColumns(input: AssetFieldsInput) {
	return {
		bin: input.bin,
		bfaType: input.bfaType,
		serviceAddress: input.serviceAddress,
		make: input.make,
		model: input.model,
		serialNumber: input.serialNumber,
		size: input.size,
		assemblyLocation: input.assemblyLocation,
		annualTestDate: input.annualTestDate,
	};
}
