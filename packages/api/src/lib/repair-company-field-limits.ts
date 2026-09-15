/**
 * Maximum lengths for the repair-company text fields.
 *
 * A module of its own, importing nothing, for the same reason
 * `asset-field-limits.ts` is one: `repair-company-input.ts` builds the Zod
 * shapes from these numbers and the repair-company form checks the same numbers
 * inline before sending, without pulling Zod into the browser bundle.
 *
 * Input hygiene, not product rules — `254` is the longest address SMTP allows.
 */
export const REPAIR_COMPANY_FIELD_LIMITS = {
	companyName: 200,
	phone: 50,
	email: 254,
} as const;
