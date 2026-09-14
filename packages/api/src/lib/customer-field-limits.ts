/**
 * Maximum lengths for the customer text fields.
 *
 * A module of its own, importing nothing, for the same reason
 * `asset-field-limits.ts` is one: `customer-input.ts` builds the Zod shapes from
 * these numbers and the customer form checks the same numbers inline before
 * sending, without pulling Zod into the browser bundle.
 *
 * Input hygiene, not product rules — `254` is the longest address SMTP allows.
 */
export const CUSTOMER_FIELD_LIMITS = {
	name: 200,
	email: 254,
	accountNumber: 100,
	address: 500,
} as const;
