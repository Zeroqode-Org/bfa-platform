import { z } from "zod";

/**
 * Input shapes for the repair-company procedures.
 *
 * They live here rather than inline in the router so the validation rules can
 * be exercised without a database connection — `routers/repair-companies.ts`
 * imports `@bfa-platform/db`, and importing that to assert that a blank company
 * name is rejected would make a pure rule need a Postgres.
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

/**
 * Optional email, validated only once there is something to validate.
 *
 * Both contact columns are nullable and the PRD asks for neither in
 * particular — a company reachable by phone alone is a real record. But an
 * address that *is* given goes into a failure notice, so a typo there is a
 * repair company the customer cannot reach. Blank collapses to NULL first;
 * anything else has to be an address.
 *
 * Normalised the same way customers and invitations are: a pasted address with
 * a stray space or a capitalised domain is accepted, and one address has one
 * spelling in the table.
 */
const optionalEmail = z
	.string()
	.trim()
	.toLowerCase()
	.nullish()
	.transform((value) => value || null)
	.pipe(z.email("Enter a valid email address").max(254).nullable());

const repairCompanyFields = {
	// Trimmed before the length check, so a name of nothing but spaces is empty
	// rather than valid.
	companyName: z.string().trim().min(1, "Company name is required").max(200),
	phone: optionalText(50),
	email: optionalEmail,
	// `inactive` is the deactivation the screen offers. There is no third state
	// and no deletion: a company that stops being approved keeps its row.
	status: z.enum(["active", "inactive"]).default("active"),
};

export const createRepairCompanyInput = z.object(repairCompanyFields);

/**
 * The update shape is the create shape plus the row's id — every field is sent,
 * so the form is the whole record and a field left out of a request is a field
 * genuinely being cleared, not one being kept.
 */
export const updateRepairCompanyInput = z.object({
	...repairCompanyFields,
	id: z.uuid(),
});

export type CreateRepairCompanyInput = z.infer<typeof createRepairCompanyInput>;
export type UpdateRepairCompanyInput = z.infer<typeof updateRepairCompanyInput>;

/**
 * The column values a validated input writes.
 *
 * A pure function of the input, with no tenant and no timestamps in it: the
 * purveyor is the router's to supply from `ctx.caller`, and keeping it out of
 * here is what makes the write set safe to reuse for the no-op comparison in
 * `updateRepairCompany`.
 */
export function repairCompanyColumns(input: CreateRepairCompanyInput) {
	return {
		companyName: input.companyName,
		phone: input.phone,
		email: input.email,
		status: input.status,
	};
}
