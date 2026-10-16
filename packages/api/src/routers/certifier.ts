import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	certifiers,
	profiles,
	testSubmissions,
	waterPurveyors,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";

import { certifierProcedure, router, TRPCError } from "../index";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import {
	draftIdInput,
	listDraftsInput,
	listSubmissionsInput,
	updateProfileInput,
} from "../lib/certifier-dashboard-input";
import { discardUnusedPhotos } from "../lib/photo-storage";
import { createStorageAdmin } from "../lib/storage-admin";
import { newestSubmittedTestFirst } from "./submitted-tests";

/**
 * A certifier's own drafts and their own submitted archive (§ 6.3).
 *
 * The mirror image of `submittedTestsRouter`: that router is a purveyor's
 * inbox, scoped by `water_purveyor_id` and pinned to `status = 'submitted'`
 * because a draft is the certifier's working copy and none of the caller's
 * business. This one is the certifier's own view of the same table, scoped by
 * `certifier_id` instead, and — unlike the WP screens — reachable at *either*
 * status, because a certifier is entitled to their own drafts.
 *
 * Every statement reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `certifierProcedure` plus the `certifier_id`
 * predicate on each query the authorization boundary in the app, and the
 * policies in `0012_certifier_dashboard_policies` the same boundary for
 * anything reaching the table through PostgREST — the RLS suite in
 * `packages/db/src/test-submissions-rls.test.ts` covers the second.
 */
export const certifierRouter = router({
	/**
	 * Every WP the caller is actively authorized for — drives the WP selector
	 * (§ 6.4). `pending`/`revoked` rows are excluded: a pending authorization
	 * has not been granted yet, and a revoked one no longer holds, so neither
	 * belongs in the dropdown a certifier picks a working purveyor from.
	 */
	listAuthorizedWps: certifierProcedure.query(({ ctx }) => {
		return db
			.select({ id: waterPurveyors.id, name: waterPurveyors.companyName })
			.from(wpCertifierAuthorizations)
			.innerJoin(
				waterPurveyors,
				eq(waterPurveyors.id, wpCertifierAuthorizations.waterPurveyorId),
			)
			.where(
				and(
					eq(wpCertifierAuthorizations.certifierId, ctx.caller.certifierId),
					eq(wpCertifierAuthorizations.authorizationStatus, "active"),
				),
			)
			.orderBy(asc(waterPurveyors.companyName));
	}),

	/**
	 * One page of the caller's own drafts, most recently saved first.
	 *
	 * `updated_at` rather than `created_at`: a certifier picking up a draft is
	 * asking "what was I last working on", and every save moves it, so the
	 * order is the wizard's own resume order.
	 */
	listDrafts: certifierProcedure
		.input(listDraftsInput)
		.query(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			return listOwnRows(
				ctx.caller.certifierId,
				input.waterPurveyorId,
				"draft",
				input,
				[desc(testSubmissions.updatedAt), asc(testSubmissions.id)],
			);
		}),

	/**
	 * One page of the caller's own submitted archive, matching the ordering
	 * the WP inbox uses for the same table — a certifier and a purveyor
	 * looking at the same row should find it in the same relative place.
	 */
	listSubmissions: certifierProcedure
		.input(listSubmissionsInput)
		.query(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			return listOwnRows(
				ctx.caller.certifierId,
				input.waterPurveyorId,
				"submitted",
				input,
				newestSubmittedTestFirst,
			);
		}),

	/**
	 * One draft, as the wizard's resume path reads it.
	 *
	 * Scoped by certifier, WP *and* status, so a foreign draft id, a draft
	 * under a WP that is not the active one, and a submitted id are all the
	 * same answer as one that does not exist — the same no-information-leak
	 * shape `getSubmittedTest` uses on the WP side.
	 */
	getDraft: certifierProcedure
		.input(draftIdInput)
		.query(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [row] = await db
				.select(certifierFullSelection)
				.from(testSubmissions)
				.leftJoin(bfaAssets, eq(bfaAssets.id, testSubmissions.bfaAssetId))
				.where(
					and(
						eq(testSubmissions.id, input.id),
						ownRowsOf(ctx.caller.certifierId, input.waterPurveyorId, "draft"),
					),
				)
				.limit(1);

			if (!row) throw notFound();

			return row;
		}),

	/** The certifier's own contact and licensing details, as the profile form reads them. */
	getProfile: certifierProcedure.query(({ ctx }) => {
		return readOwnProfile(ctx.caller.profileId);
	}),

	/**
	 * Deletes one draft.
	 *
	 * A single `DELETE ... RETURNING`, not a read followed by a delete: unlike
	 * `updateSubmittedTest`, there is no "before" row this mutation needs for a
	 * no-op comparison, so the same three refusals a read-then-write pair would
	 * need a second predicate for — missing, foreign, already submitted — are
	 * one `WHERE` clause and no race to worry about.
	 */
	deleteDraft: certifierProcedure
		.input(draftIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertAuthorizedWp(ctx.caller.certifierId, input.waterPurveyorId);

			const [row] = await db
				.delete(testSubmissions)
				.where(
					and(
						eq(testSubmissions.id, input.id),
						ownRowsOf(ctx.caller.certifierId, input.waterPurveyorId, "draft"),
					),
				)
				.returning({ id: testSubmissions.id });

			if (!row) throw notFound();

			// The draft's photos go with it; nothing can reference them any more.
			await discardUnusedPhotos(createStorageAdmin(), row.id, []);

			logCertifierEvent("draft_deleted", {
				actor: auditActor(ctx),
				certifierId: ctx.caller.certifierId,
				extra: { submission_id: row.id },
			});

			return { id: row.id };
		}),

	/**
	 * Edits the certifier's own contact and licensing details.
	 *
	 * `profiles.full_name` and the three `certifiers` columns are written in
	 * one transaction because they present as a single form — the prototype's
	 * one "Contact info" card — even though they are two rows. Both already
	 * have a self-write RLS path (0001 for the first, 0006/0007 for the other
	 * three); this procedure is the tRPC side of the same permission.
	 *
	 * A password change does not go through here. It is Supabase Auth's own
	 * write path (`supabase.auth.updateUser`), already gated by the caller's
	 * session — a second server-side procedure for it would just be relaying a
	 * call this application connection has no special standing to make.
	 */
	updateProfile: certifierProcedure
		.input(updateProfileInput)
		.mutation(async ({ ctx, input }) => {
			const { profileId, certifierId } = ctx.caller;

			const [existing] = await db
				.select({
					fullName: profiles.fullName,
					company: certifiers.company,
					idNumber: certifiers.idNumber,
					licenseExpirationDate: certifiers.licenseExpirationDate,
				})
				.from(profiles)
				.innerJoin(certifiers, eq(certifiers.profileId, profiles.id))
				.where(eq(profiles.id, profileId))
				.limit(1);

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Certifier profile not found",
				});
			}

			const changed = (Object.keys(input) as (keyof typeof input)[]).filter(
				(key) => existing[key] !== input[key],
			);

			// Opening the form and saving without touching a field is not an edit,
			// and writing one anyway would move `updated_at` on both rows for
			// nothing — the same judgement `updateSubmittedTest` makes.
			if (changed.length === 0) {
				return readOwnProfile(profileId);
			}

			await db.transaction(async (tx) => {
				await tx
					.update(profiles)
					.set({ fullName: input.fullName })
					.where(eq(profiles.id, profileId));

				await tx
					.update(certifiers)
					.set({
						company: input.company,
						idNumber: input.idNumber,
						licenseExpirationDate: input.licenseExpirationDate,
					})
					.where(eq(certifiers.id, certifierId));
			});

			logCertifierEvent("profile_updated", {
				actor: auditActor(ctx),
				certifierId,
				extra: { changed_fields: changed },
			});

			return readOwnProfile(profileId);
		}),
});

/**
 * The certifier-and-WP-and-status predicate every statement in this router
 * shares. A draft or submission's `water_purveyor_id` is fixed at creation —
 * this is what makes switching the active WP re-filter the dashboard instead
 * of merging two purveyors' rows together (§ 6.4).
 */
export function ownRowsOf(
	certifierId: string,
	waterPurveyorId: string,
	status: "draft" | "submitted",
) {
	return and(
		eq(testSubmissions.certifierId, certifierId),
		eq(testSubmissions.waterPurveyorId, waterPurveyorId),
		eq(testSubmissions.status, status),
	);
}

/**
 * Refuses a WP id the caller is not actively authorized for.
 *
 * The active WP is a client-supplied choice among several valid ones — there
 * is no single "the caller's WP" the way `wpProcedure` reads one off
 * `profiles` — so every procedure that accepts a `waterPurveyorId` calls this
 * first. This is the check that makes "a forged WP id in the request is
 * rejected server-side" (§ 6.4's own "done when") true, and the one 6.5's
 * draft-creation procedure will reuse rather than re-derive.
 */
export async function assertAuthorizedWp(
	certifierId: string,
	waterPurveyorId: string,
) {
	const [row] = await db
		.select({ id: wpCertifierAuthorizations.id })
		.from(wpCertifierAuthorizations)
		.where(
			and(
				eq(wpCertifierAuthorizations.certifierId, certifierId),
				eq(wpCertifierAuthorizations.waterPurveyorId, waterPurveyorId),
				eq(wpCertifierAuthorizations.authorizationStatus, "active"),
			),
		)
		.limit(1);

	if (!row) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Not authorized for this water purveyor",
		});
	}
}

/**
 * The row `listDrafts` and `listSubmissions` return: the submission, the BIN
 * it resolved to (if any), and its `wizardData`. Carrying the wizard data on
 * the list row rather than behind a second query keeps this router to the
 * two reads § 6.3 asks for — a certifier's own archive is small, and the
 * submitted-test detail view has no dedicated read of its own to fetch it
 * with.
 *
 * Left join, not inner: an unresolved draft (no BIN typed yet) or an
 * unresolved submission (the WP has not linked one) is a real row, and an
 * inner join would drop it rather than show `submittedBinText` in its place.
 */
const certifierRowSelection = {
	id: testSubmissions.id,
	bfaAssetId: testSubmissions.bfaAssetId,
	status: testSubmissions.status,
	bfaType: testSubmissions.bfaType,
	submittedBinText: testSubmissions.submittedBinText,
	testDate: testSubmissions.testDate,
	testResult: testSubmissions.testResult,
	currentStep: testSubmissions.currentStep,
	wizardData: testSubmissions.wizardData,
	createdAt: testSubmissions.createdAt,
	updatedAt: testSubmissions.updatedAt,
	bin: bfaAssets.bin,
};

/** `getDraft`'s shape: the list row plus the fields only a draft carries. */
const certifierFullSelection = {
	...certifierRowSelection,
	waterPurveyorId: testSubmissions.waterPurveyorId,
	overriddenFields: testSubmissions.overriddenFields,
	signatureMethod: testSubmissions.signatureMethod,
	signatureData: testSubmissions.signatureData,
};

/** One page of a certifier's own rows at the given status, for the given WP. */
async function listOwnRows(
	certifierId: string,
	waterPurveyorId: string,
	status: "draft" | "submitted",
	input: { page: number; pageSize: number },
	orderBy: SQL[],
) {
	const where = ownRowsOf(certifierId, waterPurveyorId, status);

	// Counted separately from the page, the same reasoning
	// `listSubmittedTests` gives: the count is over the whole set, the rows
	// are one page of it, and a pager needs the first even when the second
	// comes back empty.
	const [totalRow] = await db
		.select({ value: count() })
		.from(testSubmissions)
		.where(where);
	const total = totalRow?.value ?? 0;

	const rows = await db
		.select(certifierRowSelection)
		.from(testSubmissions)
		.leftJoin(bfaAssets, eq(bfaAssets.id, testSubmissions.bfaAssetId))
		.where(where)
		.orderBy(...orderBy)
		.limit(input.pageSize)
		.offset((input.page - 1) * input.pageSize);

	return {
		rows,
		total,
		page: input.page,
		pageSize: input.pageSize,
		pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
	};
}

/**
 * One refusal for a missing draft, another certifier's draft, and a
 * submitted row alike — deliberately identical, the same reasoning
 * `submitted-tests.ts`'s `notFound()` gives: a message that distinguished
 * them would confirm the row exists, which is what a guessed uuid is after.
 */
export function notFound() {
	return new TRPCError({ code: "NOT_FOUND", message: "Draft not found" });
}

async function readOwnProfile(profileId: string) {
	const [row] = await db
		.select({
			fullName: profiles.fullName,
			company: certifiers.company,
			idNumber: certifiers.idNumber,
			licenseExpirationDate: certifiers.licenseExpirationDate,
		})
		.from(profiles)
		.innerJoin(certifiers, eq(certifiers.profileId, profiles.id))
		.where(eq(profiles.id, profileId))
		.limit(1);

	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Certifier profile not found",
		});
	}

	return row;
}

/**
 * One structured JSON line per sensitive write, the same shape
 * `logSubmissionEvent` uses on the WP side — greppable by certifier rather
 * than by tenant.
 */
export function logCertifierEvent(
	event: string,
	{
		actor,
		certifierId,
		extra,
	}: {
		actor: AuditActor;
		certifierId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			certifier_id: certifierId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
