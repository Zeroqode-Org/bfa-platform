/**
 * Maximum lengths for the BFA-asset text fields.
 *
 * Deliberately a module of its own, importing nothing. `asset-input.ts` builds
 * the Zod shapes from these, and the asset form puts the same numbers on its
 * `maxLength` attributes — so the browser stops typing at exactly the point the
 * server would refuse the value, rather than at a number somebody re-typed.
 * Keeping them here rather than in `asset-input.ts` is what lets a client
 * component read them without pulling Zod into the browser bundle.
 *
 * None of these is a product rule. The columns are Postgres `text`, and neither
 * the PRD nor the build plan puts a ceiling on a BIN or an address; these are
 * input hygiene — wide enough that no real value meets them, narrow enough that
 * a pasted document does not become a row.
 */
export const ASSET_FIELD_LIMITS = {
	bin: 100,
	serviceAddress: 500,
	assemblyLocation: 500,
	make: 200,
	model: 200,
	serialNumber: 200,
	size: 100,
} as const;
