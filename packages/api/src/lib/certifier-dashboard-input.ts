import { z } from "zod";

/**
 * Input shapes for the certifier dashboard's procedures (§ 6.3, § 6.4).
 *
 * `certifierId` is absent from every shape below, the same rule
 * `submission-input.ts` states for `waterPurveyorId` on the WP side: the
 * caller's own `certifiers.id` comes from `ctx.caller` in
 * `certifierProcedure`, never from the client.
 *
 * `waterPurveyorId` is the opposite case, and deliberately present (§ 6.4):
 * a certifier's active WP is one of several valid choices with no single
 * source of truth on their profile, so the client has to say which one. What
 * makes this safe is that every procedure taking it calls
 * `assertAuthorizedWp` before using it — an id the caller is not authorized
 * for is refused server-side, not trusted.
 */

/** Free-text profile fields, wide enough for a real value, narrow enough that a
 * pasted document does not become a row. Not a product rule — see
 * `submission-field-limits.ts` for the same reasoning applied to submissions. */
const PROFILE_FIELD_LIMITS = {
	fullName: 200,
	company: 200,
	idNumber: 100,
} as const;

/**
 * One page of the caller's own drafts or submissions.
 *
 * Page-based rather than cursor-based, matching `listSubmittedTestsInput` —
 * this codebase's actual precedent for a full-table screen over a set with a
 * numbered pager, not the abstract cursor convention written for the general
 * case.
 */
const pageInput = {
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(25),
};

/**
 * The active WP, required and validated (see the module comment) — § 6.4's
 * scope-locking: "the active WP filters the entire dashboard... switching
 * WPs re-filters everything, it does not merge."
 */
const waterPurveyorIdInput = { waterPurveyorId: z.uuid() };

// No `.prefault({})` here, unlike a page-only input: `waterPurveyorId` has no
// default to fall back to, so an omitted input is correctly a validation
// error rather than a silent "which WP?".
export const listDraftsInput = z.object({
	...pageInput,
	...waterPurveyorIdInput,
});
export const listSubmissionsInput = z.object({
	...pageInput,
	...waterPurveyorIdInput,
});

export const draftIdInput = z.strictObject({
	id: z.uuid(),
	...waterPurveyorIdInput,
});

/**
 * A required text field, trimmed. Unlike the WP-side "blank clears the
 * field" convention (`optionalText` in `submission-input.ts`), a certifier's
 * own contact/licence fields are required here by product decision — a
 * client that sends an empty or missing value is refused, not treated as a
 * clear.
 */
function requiredText(max: number) {
	return z.string().trim().min(1).max(max);
}

/**
 * The profile form's field set: `profiles.full_name` plus the three
 * `certifiers` columns 0006/0007 already opened a self-write path for.
 * Every field is sent on every save — the same whole-record contract
 * `updateSubmittedTestInput` uses — so `updateProfile` can tell a field left
 * out of the request from one being cleared, and compare old against new
 * without guessing which fields were in play.
 *
 * All four are required — the client-side form enforces the same rule with
 * `packages/ui/src/lib/validation.ts`'s `required`, but this is the boundary
 * that actually holds: a request that bypasses the form is refused here too.
 */
export const updateProfileInput = z.strictObject({
	fullName: requiredText(PROFILE_FIELD_LIMITS.fullName),
	company: requiredText(PROFILE_FIELD_LIMITS.company),
	idNumber: requiredText(PROFILE_FIELD_LIMITS.idNumber),
	licenseExpirationDate: z.iso.date(),
});

export type ListDraftsInput = z.infer<typeof listDraftsInput>;
export type ListSubmissionsInput = z.infer<typeof listSubmissionsInput>;
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;
