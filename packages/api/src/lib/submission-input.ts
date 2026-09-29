import { z } from "zod";

import { SUBMISSION_FIELD_LIMITS } from "./submission-field-limits";

/**
 * Input shapes for the submitted-test procedures.
 *
 * They live here rather than inline in the router for the reason
 * `asset-input.ts` gives: `routers/submitted-tests.ts` imports
 * `@bfa-platform/db`, and importing that to assert that a client cannot send a
 * tenant would make a pure rule need a Postgres.
 *
 * Five fields are deliberately absent from every shape below, and their absence
 * is the authorization story rather than a convenience:
 *
 *   * `water_purveyor_id` — the caller's tenant comes from their own profile in
 *     `wpProcedure`. A client that sends one is sending a field the server does
 *     not read.
 *   * `status` — a WP corrects submitted tests. Reopening one as a draft would
 *     hand it back to the certifier, whose record is locked at submit (PRD § 8),
 *     and hide it from the only screen that can still reach it.
 *   * `certifier_id` — who performed the test is not a detail of the test. A
 *     correction able to move a submission onto a different certifier could
 *     move a failed test onto somebody who never attended it.
 *   * `edited_by_wp_profile_id` — the audit attribution, written by the
 *     procedure from `ctx.caller.profileId`. A client-supplied actor is not an
 *     audit trail.
 *   * `overridden_fields` — the certifier's own record of which prefilled
 *     values they overwrote, which exists so the WP can *see* what changed
 *     (PRD § 9). A WP able to rewrite it could clear the flags rather than
 *     answer them.
 *
 * `bfa_asset_id` is absent too, but for a different reason: attaching an asset
 * is `linkSubmissionAsset`'s job, and that has to check the asset's tenancy as
 * well as the submission's. A field on the correction form could not.
 */

/** The eight assembly types, matching `bfa_type` and `asset-input`'s own list. */
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

/** The two outcomes the wizard's dedicated pass/fail question records. */
export const TEST_RESULTS = ["pass", "fail"] as const;

/**
 * How the closing block was signed: the owner signed on the phone, or the
 * certifier ticked the owner-absent bypass and the stored disclaimer applies.
 */
export const SIGNATURE_METHODS = ["signed", "owner_absent"] as const;

/**
 * Optional free text. A field that has been typed into and cleared arrives as
 * `""`, not `undefined`, and storing that would give the column two spellings
 * of "empty" — so blank collapses to NULL here rather than in each caller.
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
 * An optional calendar day.
 *
 * The empty string is admitted as its own branch rather than left to the
 * transform, because `.nullish().transform()` runs the format check first —
 * a cleared date input sends `""`, and validating that as an ISO date refuses
 * the one thing "cleared" is spelled as. Accepting it here and collapsing to
 * NULL is what makes clearing a field mean clearing it.
 */
function optionalDate() {
	return z
		.union([z.iso.date(), z.literal(""), z.null(), z.undefined()])
		.transform((value) => value || null);
}

/**
 * One wizard answer.
 *
 * Scalars and null only, and no nesting. The per-BFA-type field set is the
 * wizard's to define (§ 6.5, week 4) and does not exist yet, so this shape
 * deliberately says nothing about *which* keys are legal — inventing them now
 * would mean inventing them twice. What it does say is that an answer is a
 * value a person gave to a question: a string, a number, a yes/no, or nothing.
 * A nested object arriving here would be a document smuggled through a form
 * field.
 */
const wizardValue = z.union([
	z.string().max(SUBMISSION_FIELD_LIMITS.wizardValueLength),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);

/**
 * The whole `wizard_data` bag. Capped on key count and key length as well as on
 * each value, because "any field is correctable" must not read as "any amount
 * of anything is storable".
 */
export const wizardDataInput = z
	.record(
		z.string().min(1).max(SUBMISSION_FIELD_LIMITS.wizardKeyLength),
		wizardValue,
	)
	.refine(
		(value) => Object.keys(value).length <= SUBMISSION_FIELD_LIMITS.wizardKeys,
		{
			message: `A test can carry at most ${SUBMISSION_FIELD_LIMITS.wizardKeys} fields`,
		},
	);

/**
 * The correction form's field set.
 *
 * Every one of them is sent on every save, so the form is the whole record and
 * a field left out of a request is a field genuinely being cleared — the same
 * contract `updateAssetInput` uses, and the reason `changedSubmissionFields`
 * below can compare old against new without guessing which fields were in play.
 *
 * `testDate` and `testResult` are nullable rather than required even though a
 * submitted test should carry both: the wizard that will guarantee them is week
 * 4, and a correction screen that refused to save a row already missing one
 * would be refusing to fix exactly the rows that need fixing.
 */
const submissionFields = {
	bfaType: z.enum(BFA_TYPES),
	/**
	 * What the certifier typed when no BIN resolved. Still correctable after an
	 * asset is linked: it records what was written on the day, and a WP is
	 * entitled to fix a transcription error in it without that meaning the link
	 * was wrong.
	 */
	submittedBinText: optionalText(SUBMISSION_FIELD_LIMITS.submittedBinText),
	testDate: optionalDate(),
	testResult: z
		.enum(TEST_RESULTS)
		.nullish()
		.transform((value) => value ?? null),
	signatureMethod: z
		.enum(SIGNATURE_METHODS)
		.nullish()
		.transform((value) => value ?? null),
	signatureData: optionalText(SUBMISSION_FIELD_LIMITS.signatureData),
	wizardData: wizardDataInput,
};

export const updateSubmittedTestInput = z.object({
	...submissionFields,
	id: z.uuid(),
});

/**
 * One page of a purveyor's submitted tests.
 *
 * Page-based rather than cursor-based, matching `listAssetsInput`: the screen
 * shows a numbered pager over a set measured in hundreds, and a page number is
 * what the person actually asks for.
 *
 * The three filters are independent, not a mode switch. "Failures in March" is
 * one question, and answering it by making the reader choose between a result
 * and a period would be answering a different one. Both dates are inclusive — a
 * WP asking for the 1st to the 31st means the 31st.
 */
/**
 * The filters the list and the CSV export share. One shape, so "what the table
 * shows" and "what the download contains" cannot come to mean two different
 * sets of rows.
 */
const submittedTestsFilterShape = {
	result: z.enum(TEST_RESULTS).optional(),
	/** Inclusive lower bound on `test_date`. */
	from: z.iso.date().optional(),
	/** Inclusive upper bound on `test_date`. */
	to: z.iso.date().optional(),
};

/**
 * A range that ends before it starts is a typo, not an empty result. Saying so
 * beats returning nothing and letting the reader conclude there were no tests
 * that month.
 */
function rangeRunsForwards(value: { from?: string; to?: string }) {
	return !value.from || !value.to || value.from <= value.to;
}

const backwardsRange = {
	message: "The end of the range comes before its start",
	path: ["to"],
};

export const listSubmittedTestsInput = z
	.object({
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(25),
		...submittedTestsFilterShape,
	})
	// `prefault`, not `default`: an absent input parses as `{}` and picks up each
	// field's own default, rather than needing the whole output object restated
	// here where it could drift from the fields above.
	.prefault({})
	.refine(rangeRunsForwards, backwardsRange);

/**
 * The CSV export: the list's filters, without the pager — a statement is every
 * matching row, not page one of them.
 *
 * Strict, because it arrives from a query string. A parameter the export does
 * not understand (a misspelt `form=`) is refused rather than dropped, since
 * dropping a bound quietly widens the statement.
 */
export const exportSubmittedTestsInput = z
	.strictObject(submittedTestsFilterShape)
	.refine(rangeRunsForwards, backwardsRange);

export const submissionIdInput = z.object({ id: z.uuid() });

/**
 * Attaching an asset to an unresolved submission.
 *
 * A dedicated mutation rather than a field on the correction form, because
 * resolving one is a two-sided tenancy question: the procedure has to establish
 * that the submission *and* the asset both belong to the caller's purveyor.
 * This shape only says that two uuids arrived; `linkSubmissionAsset` is the
 * boundary.
 *
 * Strict, so a client that sends `waterPurveyorId` alongside them is refused
 * rather than quietly having it dropped — a silently ignored field looks like a
 * successful request to whatever sent it.
 */
export const linkSubmissionAssetInput = z.strictObject({
	submissionId: z.uuid(),
	assetId: z.uuid(),
});

export type UpdateSubmittedTestInput = z.infer<typeof updateSubmittedTestInput>;
export type ListSubmittedTestsInput = z.infer<typeof listSubmittedTestsInput>;
export type ExportSubmittedTestsInput = z.infer<
	typeof exportSubmittedTestsInput
>;
export type WizardData = z.infer<typeof wizardDataInput>;

/**
 * The column values a validated correction writes.
 *
 * The one place the write set is defined, so the update, the no-op comparison
 * and the changed-field audit line all read from the same list — a column added
 * to the form is compared and logged too, rather than quietly becoming a field
 * that saves without leaving a trace.
 *
 * `edited_by_wp_profile_id` is not in here. It is not a value the form carries;
 * the procedure stamps it from the caller.
 */
export function submissionColumns(input: UpdateSubmittedTestInput) {
	return {
		bfaType: input.bfaType,
		submittedBinText: input.submittedBinText,
		testDate: input.testDate,
		testResult: input.testResult,
		signatureMethod: input.signatureMethod,
		signatureData: input.signatureData,
		wizardData: input.wizardData,
	};
}

/**
 * Which of the writable columns a correction actually changes.
 *
 * Returns names, never values: this list is what the audit line carries, and a
 * signature image or a customer's details do not belong in a log stream that is
 * greppable by tenant. The names answer "what did they touch", which is what an
 * audit trail is for; the values are in the row.
 *
 * Driven off `submissionColumns`' own keys rather than a hand-written list, so
 * a column added to the write set is compared here too. `wizardData` is
 * compared structurally — it is the one jsonb field, and `===` on two objects
 * parsed from the same bytes is false, which would make every save look like a
 * change to it.
 */
export function changedSubmissionFields(
	existing: Record<string, unknown>,
	next: ReturnType<typeof submissionColumns>,
): string[] {
	return Object.keys(next).filter((column) =>
		column === "wizardData"
			? !sameWizardData(existing.wizardData, next.wizardData)
			: existing[column] !== next[column as keyof typeof next],
	);
}

/**
 * Whether two `wizard_data` bags hold the same answers.
 *
 * Key order is not a difference — Postgres `jsonb` does not preserve it, so a
 * round trip can reorder keys nobody touched, and a comparison sensitive to
 * order would report a change on every save. Values are compared with
 * `Object.is`, which is `===` except that it does not claim `NaN` differs from
 * itself.
 */
function sameWizardData(existing: unknown, next: WizardData): boolean {
	if (typeof existing !== "object" || existing === null) return false;

	const before = existing as Record<string, unknown>;
	const beforeKeys = Object.keys(before);

	if (beforeKeys.length !== Object.keys(next).length) return false;

	return beforeKeys.every(
		(key) => key in next && Object.is(before[key], next[key]),
	);
}
