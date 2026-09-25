import { db } from "@bfa-platform/db";
import { bfaAssets, customers, testSubmissions } from "@bfa-platform/db/schema";
import { and, asc, desc, eq, ilike, isNull, lte, ne, sql } from "drizzle-orm";

import { certifierProcedure, router, TRPCError } from "../index";
import { auditActor } from "../lib/audit-actor";
import { sendResultDocumentEmails } from "../lib/result-pdf/distribute";
import { publishResultPdf } from "../lib/result-pdf/document-url";
import { createStorageAdmin } from "../lib/storage-admin";
import {
	BIN_SUGGESTION_LIMIT,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	carryOverAnswers,
	cleanWizardData,
	deriveTestResult,
	getPhotoUploadUrlInput,
	isOwnPhotoPath,
	lookupBinInput,
	missingWizardFields,
	OWNER_ABSENT_DISCLAIMER,
	PHOTO_PATH_KEYS,
	photoUrlsInput,
	SIGN_OFF_DISCLAIMER_KEY,
	saveDraftStepInput,
	searchBinsInput,
	submitTestInput,
} from "../lib/wizard-input";
import { applySubmittedTestResult } from "../scheduler/submission-lifecycle";
import {
	assertAuthorizedWp,
	logCertifierEvent,
	notFound,
	ownRowsOf,
} from "./certifier";

/**
 * The certifier test wizard's own procedures (§ 6.5).
 *
 * A sibling to `certifier.ts` (the dashboard, § 6.3/6.4) rather than folded
 * into it — the wizard is a separately-owned, much larger module with its own
 * input file, the same way `submitted-tests.ts` sits beside `assets.ts`
 * rather than inside it. Every procedure here still reuses `certifier.ts`'s
 * `assertAuthorizedWp`/`ownRowsOf`/`notFound`/`logCertifierEvent` rather than
 * re-deriving them, so the two routers share one authorization boundary.
 *
 * No new RLS grant backs draft creation. Every procedure here runs over the
 * privileged Drizzle connection, which already bypasses RLS — the same reason
 * `0008_test_submission_policies.sql` gives for granting no INSERT at all: "a
 * submission is created by the certifier wizard through the privileged
 * connection; a row inserted through PostgREST would be a test nobody
 * performed." `saveDraftStep`'s create branch is that privileged connection.
 */
/** A draft may only point at an asset of its own purveyor, and of the type it says it is. */
async function assertAssetFits(
	assetId: string | null,
	waterPurveyorId: string,
	bfaType: string,
) {
	if (!assetId) return;

	const [asset] = await db
		.select({ bfaType: bfaAssets.bfaType })
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset || asset.bfaType !== bfaType) throw notFound();
}

export const certifierWizardRouter = router({
	/**
	 * Creates or updates one draft step.
	 *
	 * Deliberately validation-free beyond shape and size — build-plan § 6.5
	 * step 1 is explicit that a draft save must persist a half-filled step
	 * exactly as typed. Required-field checking belongs to `submitTest` alone.
	 *
	 * `wizard_data` is replaced with what the wizard sends, which is always the
	 * whole form, so cleared or reset answers do not linger in the draft.
	 */
	saveDraftStep: certifierProcedure
		.input(saveDraftStepInput)
		.mutation(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);
			await assertAssetFits(
				input.bfaAssetId,
				input.waterPurveyorId,
				input.bfaType,
			);

			const wizardData = cleanWizardData(
				input.bfaType,
				input.wizardData,
				input.id,
			);

			if (!input.id) {
				const [created] = await db
					.insert(testSubmissions)
					.values({
						certifierId: ctx.caller.certifierId,
						waterPurveyorId: input.waterPurveyorId,
						bfaType: input.bfaType,
						wizardData,
						submittedBinText: input.submittedBinText,
						bfaAssetId: input.bfaAssetId,
						currentStep: input.currentStep,
						testDate: input.testDate,
						signatureMethod: input.signatureMethod,
						signatureData: input.signatureData,
						overriddenFields: input.overriddenFields ?? [],
					})
					.returning({ id: testSubmissions.id });

				if (!created) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Could not start a new draft",
					});
				}

				logCertifierEvent("draft_saved", {
					actor: auditActor(ctx),
					certifierId: ctx.caller.certifierId,
					extra: { submission_id: created.id, current_step: input.currentStep },
				});

				return { id: created.id };
			}

			const [updated] = await db
				.update(testSubmissions)
				.set({
					bfaType: input.bfaType,
					// Replaced, not merged: the wizard always sends the whole form, and a
					// merge would resurrect keys the certifier cleared or that a BIN or
					// type change dropped.
					wizardData,
					submittedBinText: input.submittedBinText,
					bfaAssetId: input.bfaAssetId,
					currentStep: input.currentStep,
					testDate: input.testDate,
					signatureMethod: input.signatureMethod,
					signatureData: input.signatureData,
					...(input.overriddenFields
						? { overriddenFields: input.overriddenFields }
						: {}),
				})
				.where(
					and(
						eq(testSubmissions.id, input.id),
						ownRowsOf(ctx.caller.certifierId, input.waterPurveyorId, "draft"),
					),
				)
				.returning({ id: testSubmissions.id });

			if (!updated) throw notFound();

			logCertifierEvent("draft_saved", {
				actor: auditActor(ctx),
				certifierId: ctx.caller.certifierId,
				extra: { submission_id: updated.id, current_step: input.currentStep },
			});

			return { id: updated.id };
		}),

	/**
	 * Resolves a BIN within the active WP and returns what the wizard should
	 * prefill: the asset's own assembly fields, its current customer, and the
	 * answers from its most recent submitted test (build-plan § 6.5 steps 6–8).
	 *
	 * `found: false` is a normal branch, not a thrown error — an unresolved BIN
	 * is the no-BIN flow (step 9), not a failure.
	 */
	lookupAssetByBin: certifierProcedure
		.input(lookupBinInput)
		.query(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [asset] = await db
				.select({
					id: bfaAssets.id,
					bin: bfaAssets.bin,
					bfaType: bfaAssets.bfaType,
					make: bfaAssets.make,
					model: bfaAssets.model,
					serialNumber: bfaAssets.serialNumber,
					size: bfaAssets.size,
					serviceAddress: bfaAssets.serviceAddress,
					assemblyLocation: bfaAssets.assemblyLocation,
					currentCustomerId: bfaAssets.currentCustomerId,
				})
				.from(bfaAssets)
				.where(
					and(
						eq(bfaAssets.waterPurveyorId, input.waterPurveyorId),
						eq(bfaAssets.bin, input.bin),
					),
				)
				.limit(1);

			if (!asset) return { found: false as const };

			const [priorSubmission] = await db
				.select({ wizardData: testSubmissions.wizardData })
				.from(testSubmissions)
				.where(
					and(
						eq(testSubmissions.bfaAssetId, asset.id),
						eq(testSubmissions.status, "submitted"),
					),
				)
				.orderBy(
					sql`${testSubmissions.testDate} desc nulls last`,
					desc(testSubmissions.createdAt),
				)
				.limit(1);

			const customer = asset.currentCustomerId
				? ((
						await db
							.select({ name: customers.name, email: customers.email })
							.from(customers)
							.where(eq(customers.id, asset.currentCustomerId))
							.limit(1)
					)[0] ?? null)
				: null;

			return {
				found: true as const,
				asset: {
					id: asset.id,
					bin: asset.bin,
					bfaType: asset.bfaType,
					make: asset.make,
					model: asset.model,
					serialNumber: asset.serialNumber,
					size: asset.size,
					serviceAddress: asset.serviceAddress,
					assemblyLocation: asset.assemblyLocation,
				},
				priorWizardData: priorSubmission
					? carryOverAnswers(
							asset.bfaType,
							priorSubmission.wizardData as Record<string, unknown>,
						)
					: null,
				customer,
			};
		}),

	/**
	 * BIN suggestions for the identification step's dropdown: the active WP's
	 * own assets whose BIN contains what has been typed, prefix matches first.
	 * Purely a convenience — a BIN that matches nothing is still typed freely
	 * and takes the no-BIN path (`lookupAssetByBin` stays the source of truth).
	 */
	searchBins: certifierProcedure
		.input(searchBinsInput)
		.query(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			// `%`, `_` and `\` are LIKE wildcards — a typed BIN is literal text.
			const needle = input.query.replace(/[\\%_]/g, "\\$&");

			return db
				.select({
					id: bfaAssets.id,
					bin: bfaAssets.bin,
					bfaType: bfaAssets.bfaType,
					serviceAddress: bfaAssets.serviceAddress,
				})
				.from(bfaAssets)
				.where(
					and(
						eq(bfaAssets.waterPurveyorId, input.waterPurveyorId),
						ilike(bfaAssets.bin, `%${needle}%`),
					),
				)
				.orderBy(
					sql`(${bfaAssets.bin} ilike ${`${needle}%`}) desc`,
					asc(bfaAssets.bin),
				)
				.limit(BIN_SUGGESTION_LIMIT);
		}),

	/**
	 * Short-lived links to view a test's attached photos — for the closing
	 * screen's thumbnails and the review, which cannot read the private bucket
	 * themselves. Only the caller's own test (draft or submitted, under an
	 * authorized purveyor) can be asked about, and only for paths inside that
	 * test's own folder, so a request cannot be used to sign someone else's file.
	 */
	getPhotoUrls: certifierProcedure
		.input(photoUrlsInput)
		.query(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [row] = await db
				.select({ id: testSubmissions.id })
				.from(testSubmissions)
				.where(
					and(
						eq(testSubmissions.id, input.id),
						eq(testSubmissions.certifierId, ctx.caller.certifierId),
						eq(testSubmissions.waterPurveyorId, input.waterPurveyorId),
					),
				)
				.limit(1);

			if (!row) throw notFound();

			const storage = createStorageAdmin();
			const urls: Record<string, string> = {};

			for (const path of input.paths) {
				if (!path.startsWith(`${row.id}/`) || path.includes("..")) continue;

				urls[path] = await storage.createSignedDownloadUrl(
					"test-photos",
					path,
					60 * 10,
				);
			}

			return urls;
		}),

	/**
	 * Issues a Storage signed upload URL for one closing-block photo
	 * (build-plan step 18, optional, up to two). The client uploads bytes
	 * directly to Storage, never through tRPC — this procedure only proves the
	 * caller owns the draft it is uploading against and hands back a place to
	 * put the file.
	 */
	getPhotoUploadUrl: certifierProcedure
		.input(getPhotoUploadUrlInput)
		.mutation(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [draft] = await db
				.select({ id: testSubmissions.id })
				.from(testSubmissions)
				.where(
					and(
						eq(testSubmissions.id, input.id),
						ownRowsOf(ctx.caller.certifierId, input.waterPurveyorId, "draft"),
					),
				)
				.limit(1);

			if (!draft) throw notFound();

			const path = `${input.id}/${crypto.randomUUID()}.jpg`;
			const { token } = await createStorageAdmin().createSignedUploadUrl(
				"test-photos",
				path,
			);

			return { token, path };
		}),

	/**
	 * A short-lived link to the PDF of one of the caller's own submitted tests.
	 * Scoped by certifier, purveyor and status like every read here, so a foreign,
	 * draft or missing id all answer the same not-found.
	 */
	getResultDocumentUrl: certifierProcedure
		.input(getPhotoUploadUrlInput)
		.mutation(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [row] = await db
				.select({ id: testSubmissions.id })
				.from(testSubmissions)
				.where(
					and(
						eq(testSubmissions.id, input.id),
						ownRowsOf(
							ctx.caller.certifierId,
							input.waterPurveyorId,
							"submitted",
						),
					),
				)
				.limit(1);

			if (!row) throw notFound();

			return { url: await publishResultPdf(row.id) };
		}),

	/**
	 * Locks the draft in as a submitted test (build-plan § 6.5 step 20–23).
	 *
	 * Every required field is checked here, and only here — the boundary
	 * `saveDraftStep` deliberately has none of. Once this commits, the row is
	 * immutable for the certifier: neither `saveDraftStep` nor this procedure
	 * will touch it again, because both scope their writes to `status =
	 * 'draft'`.
	 */
	submitTest: certifierProcedure
		.input(submitTestInput)
		.mutation(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [draft] = await db
				.select({
					id: testSubmissions.id,
					bfaAssetId: testSubmissions.bfaAssetId,
					overriddenFields: testSubmissions.overriddenFields,
				})
				.from(testSubmissions)
				.where(
					and(
						eq(testSubmissions.id, input.id),
						ownRowsOf(ctx.caller.certifierId, input.waterPurveyorId, "draft"),
					),
				)
				.limit(1);

			if (!draft) throw notFound();

			await assertAssetFits(
				draft.bfaAssetId,
				input.waterPurveyorId,
				input.bfaType,
			);

			// Only what belongs to this type; photos and the disclaimer are
			// rebuilt below from checked sources, never taken from the client.
			const answers = cleanWizardData(
				input.bfaType,
				input.wizardData,
				input.id,
			);
			for (const key of PHOTO_PATH_KEYS) delete answers[key];
			const photoPaths = input.photoPaths.filter((path) =>
				isOwnPhotoPath(input.id, path),
			);

			const missing = missingWizardFields(
				input.bfaType,
				answers as typeof input.wizardData,
			);
			if (missing.length > 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Missing required test fields: ${missing.join(", ")}`,
				});
			}

			if (
				input.signatureMethod === "signed" &&
				!input.signatureData?.startsWith("data:image/png;base64,")
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"A signature is required unless the owner-absent box is checked",
				});
			}

			// Customer name/email have no dedicated columns (see `wizard-input.ts`),
			// so they travel into `wizard_data` alongside every other answer. The
			// exact disclaimer wording is written server-side, never trusted from
			// the client — a request cannot substitute its own disclaimer.
			const wizardData = {
				...answers,
				[CUSTOMER_NAME_KEY]: input.customerName,
				[CUSTOMER_EMAIL_KEY]: input.customerEmail,
				...Object.fromEntries(
					photoPaths.map((path, index) => [
						PHOTO_PATH_KEYS[index] ?? `photo${index + 1}Path`,
						path,
					]),
				),
				...(input.signatureMethod === "owner_absent"
					? { [SIGN_OFF_DISCLAIMER_KEY]: OWNER_ABSENT_DISCLAIMER }
					: {}),
			};
			const signatureData =
				input.signatureMethod === "owner_absent"
					? OWNER_ABSENT_DISCLAIMER
					: input.signatureData;

			// Derived from the test block's own per-line answers, never asked a
			// second time and never trusted from the client — see
			// `deriveTestResult`'s own comment.
			const testResult = deriveTestResult(wizardData);

			const row = await db.transaction(async (tx) => {
				const [updated] = await tx
					.update(testSubmissions)
					.set({
						status: "submitted",
						bfaType: input.bfaType,
						wizardData,
						testDate: input.testDate,
						testResult,
						signatureMethod: input.signatureMethod,
						signatureData,
						currentStep: null,
					})
					.where(
						and(
							eq(testSubmissions.id, input.id),
							ownRowsOf(ctx.caller.certifierId, input.waterPurveyorId, "draft"),
						),
					)
					.returning({ id: testSubmissions.id });

				if (!updated) throw notFound();

				await applySubmittedTestResult({
					executor: tx,
					submissionId: updated.id,
					bfaAssetId: draft.bfaAssetId,
					testResult,
					waterPurveyorId: input.waterPurveyorId,
					actor: auditActor(ctx),
					trigger: "test_submitted",
				});

				// Same-BIN supersession (build-plan step 20): this certifier's own
				// prior submitted test for the same asset points forward to the new
				// one. The prior row's own columns are otherwise untouched — it
				// stays exactly as filed.
				if (draft.bfaAssetId) {
					await tx
						.update(testSubmissions)
						.set({ supersededBySubmissionId: updated.id })
						.where(
							and(
								eq(testSubmissions.bfaAssetId, draft.bfaAssetId),
								eq(testSubmissions.certifierId, ctx.caller.certifierId),
								eq(testSubmissions.status, "submitted"),
								ne(testSubmissions.id, updated.id),
								// Only the live head of the chain, and only tests that are
								// not newer than this one (a backdated entry supersedes nothing later).
								isNull(testSubmissions.supersededBySubmissionId),
								lte(testSubmissions.testDate, input.testDate),
							),
						);
				}

				return updated;
			});

			logCertifierEvent("test_submitted", {
				actor: auditActor(ctx),
				certifierId: ctx.caller.certifierId,
				extra: {
					submission_id: row.id,
					water_purveyor_id: input.waterPurveyorId,
					test_result: testResult,
				},
			});

			// Network calls, deliberately outside the transaction above. A missing
			// or failing recipient is skipped, never a reason to fail the submit
			// itself (build-plan step 23) — `sendResultDocumentEmails` guarantees
			// that by catching around each of the three sends individually.
			try {
				await sendResultDocumentEmails({
					submissionId: row.id,
					actor: auditActor(ctx),
				});
			} catch (error) {
				// The test is already filed; a PDF or mail hiccup must not report it
				// as failed (a retry would only find it submitted).
				console.error("Result document delivery failed", row.id, error);
			}

			return { id: row.id };
		}),
});
