import { db } from "@bfa-platform/db";
import { bfaAssets, customers, testSubmissions } from "@bfa-platform/db/schema";
import { and, asc, desc, eq, ilike, isNull, lte, ne, sql } from "drizzle-orm";

import { certifierProcedure, router, TRPCError } from "../index";
import {
	ASSET_ANSWER_KEYS,
	differingAssetAnswers,
	logAssetSync,
	syncAssetFromSubmission,
} from "../lib/asset-sync";
import { auditActor } from "../lib/audit-actor";
import {
	discardUnusedPhotos,
	freePhotoSlot,
	PHOTO_BUCKET,
	PRUNE_GRACE_MS,
	photoSlotPath,
	prunePhotoFolder,
} from "../lib/photo-storage";
import { sendResultDocumentEmails } from "../lib/result-pdf/distribute";
import { publishResultPdf } from "../lib/result-pdf/document-url";
import { createStorageAdmin } from "../lib/storage-admin";
import {
	allowedWizardKeys,
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
	testRefInput,
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
/**
 * A draft may only point at an asset of its own purveyor.
 *
 * Not at an asset *of the same type*, any more: the certifier may record the
 * assembly as a different BFA type than the register says (client, October
 * 2026) — the register can be wrong, and the certifier is the one standing at
 * the valve. The test keeps the type the certifier chose, the wizard marks
 * `bfaType` as overwritten, and at submit the new type is carried onto the
 * asset with the other overwritten details (`lib/asset-sync.ts`).
 */
async function assertAssetFits(
	assetId: string | null,
	waterPurveyorId: string,
) {
	if (!assetId) return;

	const [asset] = await db
		.select({ id: bfaAssets.id })
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset) throw notFound();
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
			await assertAssetFits(input.bfaAssetId, input.waterPurveyorId);

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
	 * authorized purveyor) can be asked about, and only for paths of exactly the
	 * shape `getPhotoUploadUrl` mints inside that test's own folder
	 * (`isOwnPhotoPath`), so a request cannot be used to sign someone else's file.
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
				if (!isOwnPhotoPath(row.id, path)) continue;

				// A photo removed since the draft was last saved is already gone
				// from Storage; it is skipped, not a reason to fail the others.
				try {
					urls[path] = await storage.createSignedDownloadUrl(
						PHOTO_BUCKET,
						path,
						60 * 10,
					);
				} catch {
					// Left out; the screen shows the photo as attached, without a preview.
				}
			}

			return urls;
		}),

	/**
	 * Issues a Storage signed upload URL for one closing-block photo
	 * (build-plan step 18, optional, up to two). The client uploads bytes
	 * directly to Storage, never through tRPC — this procedure only proves the
	 * caller owns the draft it is uploading against and hands back a place to
	 * put the file.
	 *
	 * The input's extension, MIME type and size are the client's claim about
	 * the file, already held to the allowlist by `getPhotoUploadUrlInput`; they
	 * only choose the key's canonical extension. The key itself — this draft's
	 * folder and one of its fixed slot ids — is always the server's, never a
	 * client name.
	 *
	 * Before choosing a slot, the draft's folder is pruned of every object the
	 * form no longer shows (`keep`, the photos currently attached): removed
	 * photos and abandoned uploads are deleted, freeing their slots. When every
	 * slot is still taken, nothing is minted (see `photo-storage.ts` for why
	 * this, and not a count, is what bounds the objects one test can create).
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

			const storage = createStorageAdmin();
			const remaining = await prunePhotoFolder(
				storage,
				draft.id,
				input.keep.filter((path) => isOwnPhotoPath(draft.id, path)),
				new Date(Date.now() - PRUNE_GRACE_MS),
			);
			const slot = freePhotoSlot(draft.id, remaining);

			if (slot === null) {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message:
						"Too many photo uploads for this test just now. Wait a minute and try again.",
				});
			}

			const path = photoSlotPath(draft.id, slot, input.extension);
			const { token } = await storage.createSignedUploadUrl(PHOTO_BUCKET, path);

			return { token, path };
		}),

	/**
	 * A short-lived link to the PDF of one of the caller's own submitted tests.
	 * Scoped by certifier, purveyor and status like every read here, so a foreign,
	 * draft or missing id all answer the same not-found.
	 */
	getResultDocumentUrl: certifierProcedure
		.input(testRefInput)
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

			await assertAssetFits(draft.bfaAssetId, input.waterPurveyorId);

			// Only what belongs to this type; photos and the disclaimer are
			// rebuilt below from checked sources, never taken from the client.
			const answers = cleanWizardData(
				input.bfaType,
				input.wizardData,
				input.id,
			);
			for (const key of PHOTO_PATH_KEYS) delete answers[key];
			// Only this draft's own paths, and only ones still in Storage — a photo
			// pruned after the form last saw it must not be filed as an attachment.
			const storage = createStorageAdmin();
			const stored = new Set(
				(await storage.list(PHOTO_BUCKET, draft.id)).map(
					(object) => `${draft.id}/${object.name}`,
				),
			);
			const photoPaths = input.photoPaths.filter(
				(path) => isOwnPhotoPath(input.id, path) && stored.has(path),
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
			// The certifier's own record of what they typed over — kept only where
			// it can be true. Not trusted as sent: a flag on an asset answer
			// (details, type, customer) survives only if the value really differs
			// from the register, because these flags are what is written onto the
			// asset; any other flag only if the key belongs to this type's form.
			// See `differingAssetAnswers`.
			const claimed = (
				input.overriddenFields ??
				(Array.isArray(draft.overriddenFields) ? draft.overriddenFields : [])
			).filter((key): key is string => typeof key === "string");
			const allowedKeys = allowedWizardKeys(input.bfaType);
			const differing = draft.bfaAssetId
				? await differingAssetAnswers({
						executor: db,
						assetId: draft.bfaAssetId,
						waterPurveyorId: input.waterPurveyorId,
						bfaType: input.bfaType,
						wizardData,
					})
				: new Set<string>();
			const overriddenFields = [...new Set(claimed)].filter((key) =>
				ASSET_ANSWER_KEYS.has(key) ? differing.has(key) : allowedKeys.has(key),
			);

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
						overriddenFields,
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

				// What the certifier overwrote about the assembly goes onto the
				// asset, when this is its latest test. See `lib/asset-sync.ts`.
				const assetSync = draft.bfaAssetId
					? await syncAssetFromSubmission({
							executor: tx,
							submissionId: updated.id,
							assetId: draft.bfaAssetId,
							waterPurveyorId: input.waterPurveyorId,
							fields: overriddenFields,
							bfaType: input.bfaType,
							wizardData,
							actor: auditActor(ctx),
						})
					: [];

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

				return { ...updated, assetSync };
			});

			// The photo set is final now; anything else in the folder is unused.
			await discardUnusedPhotos(storage, row.id, photoPaths);

			logCertifierEvent("test_submitted", {
				actor: auditActor(ctx),
				certifierId: ctx.caller.certifierId,
				extra: {
					submission_id: row.id,
					water_purveyor_id: input.waterPurveyorId,
					test_result: testResult,
				},
			});
			logAssetSync(row.assetSync, {
				actor: auditActor(ctx),
				submissionId: row.id,
				waterPurveyorId: input.waterPurveyorId,
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
