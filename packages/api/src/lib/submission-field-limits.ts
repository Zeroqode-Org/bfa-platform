/**
 * Maximum sizes for the values a WP may correct on a submitted test.
 *
 * A module of its own, importing nothing, for the same reason
 * `asset-field-limits.ts` is one: `submission-input.ts` builds the Zod shapes
 * from these numbers and the detail view puts them on its `maxLength`
 * attributes, so the browser stops typing at exactly the point the server would
 * refuse the value rather than at a number somebody re-typed. Keeping them
 * separate is what lets a client component read them without pulling Zod into
 * the browser bundle.
 *
 * None of these is a product rule. The columns are Postgres `text` and `jsonb`,
 * and neither the PRD nor the build plan puts a ceiling on a BIN or a wizard
 * answer; these are input hygiene — wide enough that no real value meets them,
 * narrow enough that a pasted document does not become a row.
 *
 * The three `wizard*` numbers are the ones worth explaining. `wizard_data` is
 * an open jsonb bag whose field set varies per BFA type, and the per-type field
 * list is the wizard's to define (§ 6.5, week 4) — so this module cannot say
 * which keys are legal, only how big the bag may get. A cap on the key count,
 * the key length and each value's length is what stops "any field" from meaning
 * "an unbounded document", without pretending to know the schema.
 */
export const SUBMISSION_FIELD_LIMITS = {
	submittedBinText: 100,
	signatureData: 200_000,
	wizardKeys: 200,
	wizardKeyLength: 120,
	wizardValueLength: 5_000,
} as const;
