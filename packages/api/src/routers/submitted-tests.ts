import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	certifiers,
	profiles,
	testSubmissions,
} from "@bfa-platform/db/schema";
import { and, asc, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import {
	changedSubmissionFields,
	linkSubmissionAssetInput,
	listSubmittedTestsInput,
	submissionColumns,
	submissionIdInput,
	updateSubmittedTestInput,
} from "../lib/submission-input";

/**
 * The two administrative WP roles, for the write half of this screen.
 *
 * Deliberately local to this router rather than a shared procedure in
 * `../index`, for the same reason `certifiersRouter` keeps its own: the
 * SubAdmin/Employee split is an open question project-wide (PRD § 10), and a
 * shared `wpAdminProcedure` would read as a project-wide answer that the next
 * feature could inherit by accident.
 *
 * What was decided for *this* screen: all three WP roles list and open
 * submitted tests, and Admin and SubAdmin correct them. An Employee is
 * read-only. That is the narrow, reversible answer — a submitted test is the
 * legal record of a backflow test, and widening this later is one predicate;
 * narrowing it later means taking access away from people who had it.
 */
const wpSubmissionEditorProcedure = wpProcedure.use(({ ctx, next }) => {
	if (
		ctx.caller.globalRole !== "wp_admin" &&
		ctx.caller.globalRole !== "wp_sub_admin"
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only a WP Admin or SubAdmin can correct a submitted test",
		});
	}

	return next({ ctx });
});

/**
 * The columns every submitted-test procedure returns. Declared once so the
 * table, the document view and the mutation responses cannot drift into three
 * shapes of the same row.
 *
 * `status` is here to be read and nowhere to be written — every query below
 * already pins it to `submitted`, so what it carries is a fact the screen can
 * show rather than a choice it can make. `waterPurveyorId` is absent: the
 * caller already knows their own tenant and no screen displays it.
 */
const submissionColumnSelection = {
	id: testSubmissions.id,
	bfaAssetId: testSubmissions.bfaAssetId,
	certifierId: testSubmissions.certifierId,
	status: testSubmissions.status,
	bfaType: testSubmissions.bfaType,
	wizardData: testSubmissions.wizardData,
	submittedBinText: testSubmissions.submittedBinText,
	testDate: testSubmissions.testDate,
	testResult: testSubmissions.testResult,
	overriddenFields: testSubmissions.overriddenFields,
	signatureMethod: testSubmissions.signatureMethod,
	signatureData: testSubmissions.signatureData,
	editedByWpProfileId: testSubmissions.editedByWpProfileId,
	createdAt: testSubmissions.createdAt,
	updatedAt: testSubmissions.updatedAt,
};

/**
 * The row as every screen wants it: the submission, the BIN it resolved to, and
 * who filed it.
 *
 * Two names, not one. `bin` is the asset's — present only when the submission
 * has been resolved to one — and `submittedBinText` is what the certifier typed
 * when it had not. The table shows whichever exists, and keeping both on the
 * row is what lets it do that without a second query per line.
 *
 * `certifierName` comes from `profiles.fullName` rather than from `certifiers`,
 * because a certifier's name is their account's name and lives in one place —
 * the same join `listWpCertifiers` makes.
 */
const submissionSelection = {
	...submissionColumnSelection,
	bin: bfaAssets.bin,
	serviceAddress: bfaAssets.serviceAddress,
	certifierName: profiles.fullName,
};

/**
 * A water purveyor's submitted tests, across every certifier who works for
 * them, and the two corrections they may make to one.
 *
 * The certifier's immutability rule does not extend to the WP. A certifier can
 * edit a test only while it is a draft and is locked out at submit (PRD § 8);
 * the purveyor who *receives* the submission may correct any field on it, which
 * is a confirmed decision (§ 9, "Correcting a submitted test") rather than an
 * exception being carved out here. The two rules coexist — locked for the
 * person who filed it, editable by the purveyor it was filed to — and every
 * correction is attributed and logged, which is what keeps "allowed" from
 * becoming "casual".
 *
 * Drafts are invisible to a WP, not merely unlisted. Every query below pins
 * `status = 'submitted'`, so a draft id names no row on the detail path either:
 * a half-finished test is the certifier's working copy, and a purveyor reading
 * one would be reading a test that has not been attested to.
 *
 * Every statement reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the `water_purveyor_id` and
 * `status` predicates on each query the authorization boundary in the app, and
 * the policies in `0008_test_submission_policies` the same boundary for
 * anything reaching the table through PostgREST. Neither is a substitute for
 * the other; the RLS suite in `packages/db/src/test-submissions-rls.test.ts`
 * covers the second.
 */
export const submittedTestsRouter = router({
	/**
	 * One page of the caller's own purveyor's submitted tests.
	 *
	 * Cross-certifier by design: this is the purveyor's inbox, not one
	 * certifier's archive, so nothing scopes it by who filed the row.
	 *
	 * The result filter and the two date bounds are independent and narrow
	 * together — "failures in March" is one question, and making the reader pick
	 * between the result and the period would answer a different one.
	 */
	listSubmittedTests: wpProcedure
		.input(listSubmittedTestsInput)
		.query(async ({ ctx, input }) => {
			const where = and(
				submittedRowsOf(ctx.caller.waterPurveyorId),
				input.result ? eq(testSubmissions.testResult, input.result) : undefined,
				// Both bounds inclusive: a WP asking for the 1st to the 31st means
				// the 31st. `test_date` is a Postgres `date`, so there is no time
				// component for an inclusive upper bound to accidentally exclude.
				input.from ? gte(testSubmissions.testDate, input.from) : undefined,
				input.to ? lte(testSubmissions.testDate, input.to) : undefined,
			);

			// Counted separately rather than with a window function: the count is
			// over the whole filtered set, the rows are one page of it, and a pager
			// that says "page 3 of 7" needs the first even when the second comes
			// back empty.
			const [totalRow] = await db
				.select({ value: count() })
				.from(testSubmissions)
				.where(where);
			const total = totalRow?.value ?? 0;

			const rows = await db
				.select(submissionSelection)
				.from(testSubmissions)
				// Left, not inner: an unresolved submission — no BIN typed, or one
				// that matched no asset — is precisely the row this screen exists to
				// surface, and an inner join would hide the ones needing work.
				.leftJoin(bfaAssets, eq(bfaAssets.id, testSubmissions.bfaAssetId))
				.innerJoin(certifiers, eq(certifiers.id, testSubmissions.certifierId))
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(where)
				.orderBy(...newestTestFirst)
				.limit(input.pageSize)
				.offset((input.page - 1) * input.pageSize);

			return {
				rows,
				total,
				page: input.page,
				pageSize: input.pageSize,
				pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
			};
		}),

	/**
	 * One submitted test, as the document view reads it.
	 *
	 * Scoped by tenant *and* status, so a foreign id and a draft id are the same
	 * answer as an id that does not exist: "Submitted test not found". A message
	 * that distinguished them would confirm the row exists somewhere, which is
	 * the one thing a cross-tenant probe is looking for.
	 *
	 * All three WP roles may read it. The edit controls are what the role split
	 * governs, and they live on the two mutations below.
	 */
	getSubmittedTest: wpProcedure
		.input(submissionIdInput)
		.query(({ ctx, input }) => {
			return readSubmission(ctx.caller.waterPurveyorId, input.id);
		}),

	/**
	 * Corrects one submitted test, and records who did it.
	 *
	 * The whole record is sent, so an omitted optional field is a field being
	 * cleared. Both the id *and* the caller's purveyor *and* the submitted status
	 * are in the predicate: scoping by id alone would let a guessed or leaked
	 * uuid be written through this privileged connection, and the read before the
	 * write is scoped the same way, so a foreign or draft row cannot even be
	 * observed on the way to being refused.
	 *
	 * `edited_by_wp_profile_id` is written from `ctx.caller.profileId` on every
	 * real correction. It is not on the input shape and never comes from the
	 * client — an actor a request can name is not an audit trail.
	 */
	updateSubmittedTest: wpSubmissionEditorProcedure
		.input(updateSubmittedTestInput)
		.mutation(async ({ ctx, input }) => {
			const waterPurveyorId = ctx.caller.waterPurveyorId;
			const tenantScopedRow = and(
				eq(testSubmissions.id, input.id),
				submittedRowsOf(waterPurveyorId),
			);

			const [existing] = await db
				.select(submissionColumnSelection)
				.from(testSubmissions)
				.where(tenantScopedRow)
				.limit(1);

			if (!existing) throw notFound();

			const next = submissionColumns(input);
			const changed = changedSubmissionFields(existing, next);

			// Opening the document and pressing save without touching a field is not
			// a correction, and writing one anyway would make two records lie.
			// `updated_at` — moved by the `set_updated_at` trigger on any UPDATE at
			// all — would come to mean "when somebody last pressed save", and
			// `edited_by_wp_profile_id` would name the last person to *look* at the
			// test rather than the last person to change it. On a record that is
			// evidence of a backflow test, that is the difference between an
			// attribution and a footprint.
			if (changed.length === 0) {
				return readSubmission(waterPurveyorId, input.id);
			}

			const [row] = await db
				.update(testSubmissions)
				.set({ ...next, editedByWpProfileId: ctx.caller.profileId })
				.where(tenantScopedRow)
				.returning({ id: testSubmissions.id });

			if (!row) throw notFound();

			logSubmissionEvent("test_submission_corrected", {
				actorId: ctx.caller.profileId,
				submissionId: row.id,
				waterPurveyorId,
				extra: {
					certifier_id: existing.certifierId,
					// Names, not values. Which fields a purveyor touched is the audit
					// question; the answers are in the row, and a signature image or a
					// customer's details have no business in a log stream.
					changed_fields: changed,
				},
			});

			return readSubmission(waterPurveyorId, row.id);
		}),

	/**
	 * Attaches an asset to a submission that never resolved to one.
	 *
	 * The no-BIN flow (PRD § 7, flow 2) is deliberate: a certifier may leave the
	 * BIN blank and fill in the rest, and working out which assembly it belongs
	 * to is the purveyor's job afterward. This is that job.
	 *
	 * Its own mutation rather than a field on the correction form, because it is
	 * a two-sided tenancy question — both the submission and the asset have to
	 * belong to the caller's purveyor — and because the BIN is the single most
	 * protected value in a submission (§ 9). Resolving one to the wrong assembly
	 * files a test against the wrong valve, so the write refuses a submission
	 * that already has an asset rather than silently re-pointing it: changing an
	 * existing link is a different act from making a missing one, and it is not
	 * this screen's.
	 */
	linkSubmissionAsset: wpSubmissionEditorProcedure
		.input(linkSubmissionAssetInput)
		.mutation(async ({ ctx, input }) => {
			const waterPurveyorId = ctx.caller.waterPurveyorId;

			const [submission] = await db
				.select({
					id: testSubmissions.id,
					bfaAssetId: testSubmissions.bfaAssetId,
					certifierId: testSubmissions.certifierId,
					submittedBinText: testSubmissions.submittedBinText,
				})
				.from(testSubmissions)
				.where(
					and(
						eq(testSubmissions.id, input.submissionId),
						submittedRowsOf(waterPurveyorId),
					),
				)
				.limit(1);

			if (!submission) throw notFound();

			if (submission.bfaAssetId) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "This test is already linked to an asset",
				});
			}

			// The cross-tenant refusal. The asset is looked up inside the caller's
			// own purveyor, so an asset belonging to another WP is not "rejected"
			// after being found — it is never found at all, and the message says
			// nothing about whether that uuid exists elsewhere.
			const [asset] = await db
				.select({ id: bfaAssets.id, bin: bfaAssets.bin })
				.from(bfaAssets)
				.where(
					and(
						eq(bfaAssets.id, input.assetId),
						eq(bfaAssets.waterPurveyorId, waterPurveyorId),
					),
				)
				.limit(1);

			if (!asset) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No asset with that id in this water purveyor",
				});
			}

			// `is null` in the predicate as well as in the check above: between the
			// read and the write, another clerk may have linked the same submission.
			// Without it the second request would quietly overwrite the first
			// answer; with it, it matches no row and is reported as a conflict.
			const [row] = await db
				.update(testSubmissions)
				.set({
					bfaAssetId: asset.id,
					editedByWpProfileId: ctx.caller.profileId,
				})
				.where(
					and(
						eq(testSubmissions.id, submission.id),
						isNull(testSubmissions.bfaAssetId),
						submittedRowsOf(waterPurveyorId),
					),
				)
				.returning({ id: testSubmissions.id });

			if (!row) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "This test was linked to an asset while you were working",
				});
			}

			// The sensitive one. This is the write that decides which physical valve
			// a test belongs to, so it carries what the certifier typed alongside
			// the BIN it was resolved to — the two values somebody re-checking the
			// decision needs.
			logSubmissionEvent("test_submission_asset_linked", {
				actorId: ctx.caller.profileId,
				submissionId: row.id,
				waterPurveyorId,
				extra: {
					certifier_id: submission.certifierId,
					bfa_asset_id: asset.id,
					bin: asset.bin,
					submitted_bin_text: submission.submittedBinText,
				},
			});

			return readSubmission(waterPurveyorId, row.id);
		}),
});

/**
 * The tenant-and-status predicate every statement in this router shares.
 *
 * One function rather than two clauses repeated six times, because these two
 * conditions are one rule — "rows this purveyor is entitled to see" — and a
 * query that picked up only the first would be a cross-tenant leak or a draft
 * leak depending on which half was forgotten.
 */
function submittedRowsOf(waterPurveyorId: string) {
	return and(
		eq(testSubmissions.waterPurveyorId, waterPurveyorId),
		eq(testSubmissions.status, "submitted"),
	);
}

/**
 * Newest test first, with a total order behind it.
 *
 * `test_date` is nullable, and a submission missing one is not the most recent
 * test — it is a record with a gap in it — so nulls sort last rather than
 * ahead of everything. `created_at` then `id` break the tie, so a page boundary
 * cannot repeat or skip a row between two tests dated the same day, which is
 * ordinary: a certifier files a morning's work in one sitting.
 */
const newestTestFirst = [
	sql`${testSubmissions.testDate} desc nulls last`,
	desc(testSubmissions.createdAt),
	asc(testSubmissions.id),
];

/** One submitted test in the caller's purveyor, or a not-found. */
async function readSubmission(waterPurveyorId: string, submissionId: string) {
	const [row] = await db
		.select(submissionSelection)
		.from(testSubmissions)
		.leftJoin(bfaAssets, eq(bfaAssets.id, testSubmissions.bfaAssetId))
		.innerJoin(certifiers, eq(certifiers.id, testSubmissions.certifierId))
		.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
		.where(
			and(
				eq(testSubmissions.id, submissionId),
				submittedRowsOf(waterPurveyorId),
			),
		)
		.limit(1);

	if (!row) throw notFound();

	return row;
}

/**
 * The one refusal this router gives for a missing row, a draft, and another
 * purveyor's submission alike.
 *
 * Deliberately identical in all three cases. A message that said "that is a
 * draft" or "that belongs to another purveyor" would confirm the row exists,
 * which is the single fact a probe with a guessed uuid is after.
 */
function notFound() {
	return new TRPCError({
		code: "NOT_FOUND",
		message: "Submitted test not found",
	});
}

/**
 * One structured JSON line per sensitive write, in the same shape as
 * `bfa_asset_updated` and `caller_resolved`. A string log would not be
 * greppable by tenant, which is the whole point of carrying `wp_id`.
 */
function logSubmissionEvent(
	event: string,
	{
		actorId,
		submissionId,
		waterPurveyorId,
		extra,
	}: {
		actorId: string;
		submissionId: string;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			actor_id: actorId,
			submission_id: submissionId,
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
