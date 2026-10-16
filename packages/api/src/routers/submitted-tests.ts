import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	certifiers,
	customerAssignments,
	customers,
	profiles,
	testSubmissions,
} from "@bfa-platform/db/schema";
import { and, asc, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import { assetColumns } from "../lib/asset-input";
import {
	BFA_TYPE_FIELD,
	changedWizardKeys,
	findOrCreateCustomer,
	logAssetSync,
	syncAssetFromSubmission,
} from "../lib/asset-sync";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import { publishResultPdf } from "../lib/result-pdf/document-url";
import type { StatementRow } from "../lib/statement-columns";
import { createStorageAdmin } from "../lib/storage-admin";
import { newAssetFromSubmission } from "../lib/submission-asset";
import {
	changedSubmissionFields,
	type ExportSubmittedTestsInput,
	exportSubmittedTestsInput,
	linkSubmissionAssetInput,
	listSubmittedTestsInput,
	submissionColumns,
	submissionIdInput,
	updateSubmittedTestInput,
} from "../lib/submission-input";
import { isUniqueViolation } from "../lib/unique-violation";
import {
	isOwnPhotoPath,
	OWNER_ABSENT_DISCLAIMER,
	PHOTO_PATH_KEYS,
	SIGN_OFF_DISCLAIMER_KEY,
} from "../lib/wizard-input";
import { reconcileAssetNoticeChain } from "../scheduler/notice-chain";
import { applySubmittedTestResult } from "../scheduler/submission-lifecycle";

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
			const where = submittedTestsMatching(ctx.caller.waterPurveyorId, input);

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
				// The customer column is the CSV statement's own rule — whoever
				// occupied the asset on the test date — so the table a WP checks
				// before downloading names the same person the file will.
				.select({ ...submissionSelection, customerName: customers.name })
				.from(testSubmissions)
				// Left, not inner: an unresolved submission — no BIN typed, or one
				// that matched no asset — is precisely the row this screen exists to
				// surface, and an inner join would hide the ones needing work.
				//
				// Tenant-scoped in the `ON` clause as well as by id — see
				// `tenantAsset` below for why the foreign key is not enough, and why
				// this belongs here rather than in the `where`.
				.leftJoin(bfaAssets, tenantAsset(ctx.caller.waterPurveyorId))
				.leftJoin(customers, customerOnTestDate(ctx.caller.waterPurveyorId))
				.innerJoin(certifiers, eq(certifiers.id, testSubmissions.certifierId))
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(where)
				.orderBy(...newestSubmittedTestFirst)
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
	 * Every submitted test the list's filters match, for the CSV statement
	 * (PRD § 6.12). Served as a file by `/api/wp/submitted-tests/export`, which
	 * calls this through `createCaller` so the tenancy and role checks are this
	 * procedure's and nobody else's.
	 *
	 * The same `where` as `listSubmittedTests`, built by the same function, so
	 * "what the table shows" and "what the download contains" are one set of
	 * rows. All three WP roles may run it: it is a read, and an Employee can
	 * already page through every one of these rows on screen.
	 *
	 * Bounded, and loudly so. Past `STATEMENT_ROW_LIMIT` it refuses rather than
	 * handing back the first N rows, because a statement missing its tail looks
	 * exactly like a complete one.
	 */
	exportSubmittedTests: wpProcedure
		.input(exportSubmittedTestsInput)
		.query(async ({ ctx, input }): Promise<StatementRow[]> => {
			const waterPurveyorId = ctx.caller.waterPurveyorId;

			const rows = await db
				.select({
					customerName: customers.name,
					bin: bfaAssets.bin,
					submittedBinText: testSubmissions.submittedBinText,
					serviceAddress: bfaAssets.serviceAddress,
					bfaType: testSubmissions.bfaType,
					testDate: testSubmissions.testDate,
					testResult: testSubmissions.testResult,
					certifierName: profiles.fullName,
				})
				.from(testSubmissions)
				// Left, as on the list: an unresolved submission belongs in the
				// statement, with its customer and address blank.
				.leftJoin(bfaAssets, tenantAsset(waterPurveyorId))
				.leftJoin(customers, customerOnTestDate(waterPurveyorId))
				.innerJoin(certifiers, eq(certifiers.id, testSubmissions.certifierId))
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(submittedTestsMatching(waterPurveyorId, input))
				.orderBy(...newestSubmittedTestFirst)
				// One past the limit, so "exactly at it" and "over it" differ.
				.limit(STATEMENT_ROW_LIMIT + 1);

			if (rows.length > STATEMENT_ROW_LIMIT) {
				throw new TRPCError({
					code: "PAYLOAD_TOO_LARGE",
					message: `More than ${STATEMENT_ROW_LIMIT.toLocaleString("en-US")} tests match — narrow the date range and export it in parts`,
				});
			}

			console.log(
				JSON.stringify({
					event: "submitted_tests_exported",
					...auditActorFields(auditActor(ctx)),
					wp_id: waterPurveyorId,
					from: input.from ?? null,
					to: input.to ?? null,
					result: input.result ?? null,
					row_count: rows.length,
					timestamp: new Date().toISOString(),
				}),
			);

			return rows;
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
	 * A short-lived link to the PDF of one submitted test, drawn from the record
	 * as it stands now — so a correction a purveyor has made is in the file.
	 * Readable by all three WP roles, like the document view itself, and scoped
	 * the same way: tenant and `submitted` status, one not-found for anything else.
	 */
	getResultDocumentUrl: wpProcedure
		.input(submissionIdInput)
		.mutation(async ({ ctx, input }) => {
			const row = await readSubmission(ctx.caller.waterPurveyorId, input.id);

			return { url: await publishResultPdf(row.id) };
		}),

	/**
	 * Short-lived links to view one submitted test's photos, keyed by storage
	 * path — the document shows them as thumbnails rather than as paths.
	 *
	 * Takes only the submission id: the paths signed are the ones stored on the
	 * row, and only those inside that submission's own folder, so a request can
	 * never name a file to sign. Scoped like every read here, so a draft or a
	 * foreign id gets the same not-found. Readable by all three WP roles, like
	 * the document itself.
	 */
	getPhotoUrls: wpProcedure
		.input(submissionIdInput)
		.query(async ({ ctx, input }) => {
			const row = await readSubmission(ctx.caller.waterPurveyorId, input.id);
			const wizardData = (row.wizardData ?? {}) as Record<string, unknown>;
			const storage = createStorageAdmin();
			const urls: Record<string, string> = {};

			for (const key of PHOTO_PATH_KEYS) {
				const path = wizardData[key];

				if (typeof path !== "string" || !isOwnPhotoPath(row.id, path)) {
					continue;
				}

				urls[path] = await storage.createSignedDownloadUrl(
					"test-photos",
					path,
					60 * 10,
				);
			}

			return urls;
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
	 * client — an actor a request can name is not an audit trail. The column
	 * records the WP profile the edit was made as; the log line's `actor_id` is
	 * the real signed-in account, which differs while a Super-Admin impersonates.
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

			const next = withConsistentSignOff(
				submissionColumns(input),
				existing.signatureMethod,
			);
			const changed = changedSubmissionFields(existing, next);

			// A BIN given to an unlinked test *in this save* numbers a new
			// assembly: the save registers the asset and links the test to it. See
			// `createAssetFromSubmission`. Only when the BIN is new or changed here
			// — a BIN already on the row (typed by the certifier) does not turn
			// every later correction into an asset registration, and a save that
			// changes nothing stays a no-op.
			if (
				!existing.bfaAssetId &&
				next.submittedBinText &&
				next.submittedBinText !== existing.submittedBinText
			) {
				return createAssetFromSubmission({
					waterPurveyorId,
					editorProfileId: ctx.caller.profileId,
					actor: auditActor(ctx),
					existing,
					next,
					changed,
				});
			}

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

			const row = await db.transaction(async (tx) => {
				const [updated] = await tx
					.update(testSubmissions)
					.set({ ...next, editedByWpProfileId: ctx.caller.profileId })
					.where(tenantScopedRow)
					.returning({ id: testSubmissions.id });

				if (!updated) throw notFound();

				// What this row's result now means for the notice machinery — one
				// exported rule, not a per-caller derivation: a linked pass ends
				// the assembly's escalation and withdraws this submission's unsent
				// failure notice; a linked fail queues its failure notice, due
				// immediately and idempotently. Every query in this router pins
				// `status = 'submitted'`, so a draft cannot reach here at all —
				// which is the rule, not a side effect: an unattested working copy
				// must neither stop a purveyor's notices nor send one.
				//
				// Run unconditionally from the row's current state rather than only
				// when the result changed. Re-applying an unchanged state writes
				// nothing, and the alternative leaves a chain running — or a
				// failure notice unqueued — whenever the result was recorded
				// before the asset link.
				await applySubmittedTestResult({
					executor: tx,
					submissionId: updated.id,
					bfaAssetId: existing.bfaAssetId,
					testResult: next.testResult,
					waterPurveyorId,
					actor: auditActor(ctx),
					trigger: "test_submission_corrected",
				});

				// What this save changed about the assembly goes onto the asset
				// too — only the answers changed here, and only from the asset's
				// latest test. See `lib/asset-sync.ts`.
				const assetSync = existing.bfaAssetId
					? await syncAssetFromSubmission({
							executor: tx,
							submissionId: updated.id,
							assetId: existing.bfaAssetId,
							waterPurveyorId,
							fields: [
								...changedWizardKeys(existing.wizardData, next.wizardData),
								...(existing.bfaType !== next.bfaType ? [BFA_TYPE_FIELD] : []),
							],
							bfaType: next.bfaType,
							wizardData: next.wizardData,
							actor: auditActor(ctx),
						})
					: [];

				return { ...updated, assetSync };
			});

			logSubmissionEvent("test_submission_corrected", {
				actor: auditActor(ctx),
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

			logAssetSync(row.assetSync, {
				actor: auditActor(ctx),
				submissionId: row.id,
				waterPurveyorId,
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
					// Read for the notice chain: linking a passing test to an assembly
					// is the moment that pass becomes a fact about that assembly, and
					// therefore the moment its escalation ends.
					testResult: testSubmissions.testResult,
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
			const row = await db.transaction(async (tx) => {
				const [linked] = await tx
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

				if (!linked) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "This test was linked to an asset while you were working",
					});
				}

				// The link is the moment this test's result becomes a fact about
				// that assembly: a pass ends its escalation, and a fail — the
				// no-BIN failure the purveyor has just resolved to a valve — queues
				// its failure notice. In the same transaction as the link, because
				// a link that committed without them would leave a late notice
				// queued against a passed assembly, or a failed one with nobody
				// told.
				await applySubmittedTestResult({
					executor: tx,
					submissionId: linked.id,
					bfaAssetId: asset.id,
					testResult: submission.testResult,
					waterPurveyorId,
					actor: auditActor(ctx),
					trigger: "test_submission_asset_linked",
				});

				return linked;
			});

			// The sensitive one. This is the write that decides which physical valve
			// a test belongs to, so it carries what the certifier typed alongside
			// the BIN it was resolved to — the two values somebody re-checking the
			// decision needs.
			logSubmissionEvent("test_submission_asset_linked", {
				actor: auditActor(ctx),
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
 * The sign-off kept consistent with how it was signed, whatever the client
 * sent — the way `submitTest` writes it — when this save changes how it was
 * signed. A save that leaves the method alone keeps the stored sign-off as it
 * is, so a row stored before this rule (an owner-absent test carrying an
 * image) does not read as changed on a save that touched nothing.
 *
 * - Owner absent: the signature column holds the mandatory disclaimer, and so
 *   does `wizard_data`. Never an image: the PDF prints that column as the
 *   disclaimer's text, so an image left there would print as base64.
 * - Signed or not recorded: no disclaimer in `wizard_data`.
 *
 * The wording is the server's constant, never the client's — a correction
 * cannot rewrite the certification text any more than the wizard can.
 */
function withConsistentSignOff(
	next: ReturnType<typeof submissionColumns>,
	storedMethod: string | null,
): ReturnType<typeof submissionColumns> {
	if (next.signatureMethod === storedMethod) return next;

	const { [SIGN_OFF_DISCLAIMER_KEY]: _disclaimer, ...answers } =
		next.wizardData;

	if (next.signatureMethod === "owner_absent") {
		return {
			...next,
			signatureData: OWNER_ABSENT_DISCLAIMER,
			wizardData: {
				...answers,
				[SIGN_OFF_DISCLAIMER_KEY]: OWNER_ABSENT_DISCLAIMER,
			},
		};
	}

	return { ...next, wizardData: answers };
}

/** The constraint that makes a BIN unique inside one purveyor. */
const ASSET_BIN_UNIQUE_KEY = "bfa_assets_water_purveyor_id_bin_key";

function binTakenError(bin: string, cause?: unknown) {
	return new TRPCError({
		code: "CONFLICT",
		message: `BIN ${bin} is already in use by another asset. To attach this test to it, use Link in the list above.`,
		cause,
	});
}

/**
 * The no-BIN save: registers the assembly a WP has just given a BIN to, and
 * links the test to it, in one transaction.
 *
 * A new BFA has no BIN when it is first tested, so the certifier leaves the
 * field blank; the purveyor numbers it afterward by typing the BIN into the
 * test and saving (client, October 2026). Every unlinked test saved with a BIN
 * on it takes this path — including one whose certifier typed a BIN that
 * matched nothing — because an unlinked test carrying a BIN is exactly the
 * state "this assembly is not registered yet" describes.
 *
 * Refused before anything is written, and the save with it:
 *
 * - a BIN the purveyor already uses — that test belongs to an existing asset,
 *   which `linkSubmissionAsset` attaches, and registering a second valve under
 *   the same number is never the answer;
 * - a test that cannot describe an asset (no test date, no service address) —
 *   see `newAssetFromSubmission`.
 *
 * Order inside the transaction is load-bearing. The test is linked and its
 * result applied *before* the reminder chain is scheduled, because a linked
 * pass cancels the asset's open notice jobs: scheduled first, next year's
 * reminder would be cancelled by the very test that set its date.
 */
async function createAssetFromSubmission({
	waterPurveyorId,
	editorProfileId,
	actor,
	existing,
	next,
	changed,
}: {
	waterPurveyorId: string;
	/** The WP profile the edit is made as — see `updateSubmittedTest`. */
	editorProfileId: string;
	actor: AuditActor;
	existing: {
		id: string;
		certifierId: string;
		submittedBinText: string | null;
	};
	next: ReturnType<typeof submissionColumns>;
	changed: string[];
}) {
	const result = newAssetFromSubmission(next);

	if (!result.ok) {
		throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
	}

	const { asset: assetInput, customer: wizardCustomer } = result.plan;

	// Checked up front for the message; the unique index below is what actually
	// decides, so a second clerk taking the BIN in between is refused too.
	const [taken] = await db
		.select({ id: bfaAssets.id })
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
				eq(bfaAssets.bin, assetInput.bin),
			),
		)
		.limit(1);

	if (taken) throw binTakenError(assetInput.bin);

	const outcome = await db.transaction(async (tx) => {
		const customer = wizardCustomer
			? await findOrCreateCustomer(tx, waterPurveyorId, wizardCustomer)
			: null;

		const [asset] = await tx
			.insert(bfaAssets)
			.values({
				...assetColumns(assetInput),
				waterPurveyorId,
				currentCustomerId: customer?.id ?? null,
			})
			.returning({
				id: bfaAssets.id,
				bin: bfaAssets.bin,
				bfaType: bfaAssets.bfaType,
				annualTestDate: bfaAssets.annualTestDate,
			})
			.catch((error: unknown) => {
				throw isUniqueViolation(error, ASSET_BIN_UNIQUE_KEY)
					? binTakenError(assetInput.bin, error)
					: error;
			});

		if (!asset) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Asset insert returned no row",
			});
		}

		if (customer) {
			await tx.insert(customerAssignments).values({
				bfaAssetId: asset.id,
				customerId: customer.id,
				startDate: sql`current_date`,
			});
		}

		// `is null` in the predicate, as in `linkSubmissionAsset`: another clerk
		// may have linked this test since it was read, and that answer is not
		// this save's to overwrite.
		const [linked] = await tx
			.update(testSubmissions)
			.set({
				...next,
				bfaAssetId: asset.id,
				editedByWpProfileId: editorProfileId,
			})
			.where(
				and(
					eq(testSubmissions.id, existing.id),
					isNull(testSubmissions.bfaAssetId),
					submittedRowsOf(waterPurveyorId),
				),
			)
			.returning({ id: testSubmissions.id });

		if (!linked) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "This test was linked to an asset while you were working",
			});
		}

		await applySubmittedTestResult({
			executor: tx,
			submissionId: linked.id,
			bfaAssetId: asset.id,
			testResult: next.testResult,
			waterPurveyorId,
			actor,
			trigger: "test_submission_asset_linked",
		});

		await reconcileAssetNoticeChain({
			executor: tx,
			assetId: asset.id,
			waterPurveyorId,
			annualTestDate: asset.annualTestDate,
			actor,
			trigger: "asset_created",
		});

		return { asset, customer };
	});

	const { asset, customer } = outcome;

	if (customer?.created) {
		console.log(
			JSON.stringify({
				event: "customer_created",
				...auditActorFields(actor),
				customer_id: customer.id,
				wp_id: waterPurveyorId,
				rate_category: "standard",
				status: customer.status,
				source: "no_bin_submission",
				submission_id: existing.id,
				timestamp: new Date().toISOString(),
			}),
		);
	}

	logSubmissionEvent("bfa_asset_created", {
		actor,
		submissionId: existing.id,
		waterPurveyorId,
		extra: {
			asset_id: asset.id,
			bin: asset.bin,
			bfa_type: asset.bfaType,
			annual_test_date: asset.annualTestDate,
			current_customer_id: customer?.id ?? null,
			source: "no_bin_submission",
		},
	});

	if (customer) {
		logSubmissionEvent("bfa_asset_customer_assigned", {
			actor,
			submissionId: existing.id,
			waterPurveyorId,
			extra: {
				asset_id: asset.id,
				bin: asset.bin,
				from: null,
				to: customer.id,
				to_customer_suspended: customer.status === "suspended",
			},
		});
	}

	if (changed.length > 0) {
		logSubmissionEvent("test_submission_corrected", {
			actor,
			submissionId: existing.id,
			waterPurveyorId,
			extra: { certifier_id: existing.certifierId, changed_fields: changed },
		});
	}

	logSubmissionEvent("test_submission_asset_linked", {
		actor,
		submissionId: existing.id,
		waterPurveyorId,
		extra: {
			certifier_id: existing.certifierId,
			bfa_asset_id: asset.id,
			bin: asset.bin,
			submitted_bin_text: existing.submittedBinText,
			asset_created: true,
		},
	});

	return readSubmission(waterPurveyorId, existing.id);
}

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
 * The list's filters on top of `submittedRowsOf`. Shared by the list and the
 * CSV export, so the two cannot drift into different answers to the same
 * question.
 *
 * The result filter and the two date bounds are independent and narrow
 * together. Both bounds are inclusive: a WP asking for the 1st to the 31st
 * means the 31st, and `test_date` is a Postgres `date`, so there is no time
 * component for an inclusive upper bound to accidentally exclude.
 */
function submittedTestsMatching(
	waterPurveyorId: string,
	filters: ExportSubmittedTestsInput,
) {
	return and(
		submittedRowsOf(waterPurveyorId),
		filters.result ? eq(testSubmissions.testResult, filters.result) : undefined,
		filters.from ? gte(testSubmissions.testDate, filters.from) : undefined,
		filters.to ? lte(testSubmissions.testDate, filters.to) : undefined,
	);
}

/**
 * The most rows one CSV statement carries. A purveyor's month is hundreds of
 * tests; a request for thousands more than that is usually an open range, and
 * the answer is a narrower one rather than an unbounded read.
 */
const STATEMENT_ROW_LIMIT = 5000;

/**
 * The customer a statement line names: whoever occupied the asset on the day
 * it was tested, not whoever occupies it now. A statement for last spring has
 * to say who was billed last spring, even if the property has changed hands.
 *
 * Read from `customer_assignments`. Reassigning closes the old row and opens
 * the new one on the same day, so a test on a changeover day matches both;
 * the later `start_date` wins, which is the occupant the WP had moved it to.
 *
 * Falls back to `bfa_assets.current_customer_id` only for an asset with *no*
 * occupancy history at all. An asset that has history but none covering the
 * test date had no customer on that day, and borrowing today's would put a
 * name on a test that person never had.
 *
 * Scoped to the caller's purveyor in the `ON`, for the same reason
 * `tenantAsset` is: a pointer that crossed tenants comes back as a blank name
 * rather than another purveyor's customer.
 */
function customerOnTestDate(waterPurveyorId: string) {
	const occupant = sql`(
		select ${customerAssignments.customerId}
		from ${customerAssignments}
		where ${customerAssignments.bfaAssetId} = ${bfaAssets.id}
			and ${customerAssignments.startDate} <= ${testSubmissions.testDate}
			and (${customerAssignments.endDate} is null
				or ${customerAssignments.endDate} >= ${testSubmissions.testDate})
		order by ${customerAssignments.startDate} desc,
			${customerAssignments.createdAt} desc
		limit 1
	)`;
	const neverAssigned = sql`not exists (
		select 1 from ${customerAssignments}
		where ${customerAssignments.bfaAssetId} = ${bfaAssets.id}
	)`;

	return and(
		eq(customers.waterPurveyorId, waterPurveyorId),
		sql`${customers.id} = coalesce(
			${occupant},
			case when ${neverAssigned} then ${bfaAssets.currentCustomerId} end
		)`,
	);
}

/**
 * The join condition attaching a submission to its asset: the right row, *and*
 * the caller's own purveyor.
 *
 * Both halves are load-bearing. `test_submissions.water_purveyor_id` scopes the
 * submission, and the foreign key on `bfa_asset_id` proves only that the asset
 * exists — not that it belongs to the same purveyor. A link that crossed
 * tenants would otherwise pull a foreign asset's BIN and service address onto a
 * row this caller is entitled to read, through the privileged connection, on
 * both the list and the detail path.
 *
 * `linkSubmissionAsset` has always refused to *create* such a link, and
 * `0009_test_submission_asset_tenancy` added the same clause to the row policy's
 * WITH CHECK. Neither retroactively cleans a row written before them, and
 * deliberately so: `0009` kept the clause out of USING precisely so an
 * already-crossed row stays reachable and repairable. This is the read side of
 * that decision — the row stays visible, its foreign asset does not.
 *
 * In the `ON` clause rather than the `where`, which is the difference between
 * failing safe and failing silent. Here, a mismatched row comes back with null
 * asset columns — exactly how an unlinked submission already reads, and a state
 * both screens already render as "not linked to an asset". In the `where` it
 * would vanish from the list altogether, hiding the one row that needs fixing.
 */
function tenantAsset(waterPurveyorId: string) {
	return and(
		eq(bfaAssets.id, testSubmissions.bfaAssetId),
		eq(bfaAssets.waterPurveyorId, waterPurveyorId),
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
 *
 * Exported because the WP dashboard's "incoming reports" list is the head of
 * *this* list — the reader clicks a row there and lands on the document this
 * screen opens. Restating the ordering there would have made that true only
 * until one of the two copies was edited.
 */
export const newestSubmittedTestFirst = [
	sql`${testSubmissions.testDate} desc nulls last`,
	desc(testSubmissions.createdAt),
	asc(testSubmissions.id),
];

/** One submitted test in the caller's purveyor, or a not-found. */
async function readSubmission(waterPurveyorId: string, submissionId: string) {
	const [row] = await db
		.select(submissionSelection)
		.from(testSubmissions)
		.leftJoin(bfaAssets, tenantAsset(waterPurveyorId))
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
		actor,
		submissionId,
		waterPurveyorId,
		extra,
	}: {
		actor: AuditActor;
		submissionId: string;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			submission_id: submissionId,
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
