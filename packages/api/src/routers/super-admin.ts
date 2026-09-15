import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	profiles,
	testSubmissions,
	waterPurveyors,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";

import { findImpersonationTarget } from "../context";
import {
	router,
	superAdminActorProcedure,
	superAdminProcedure,
	TRPCError,
} from "../index";
import { auditActor, auditActorFields } from "../lib/audit-actor";
import {
	createImpersonationToken,
	impersonationSecret,
	serializeClearedImpersonationCookie,
	serializeImpersonationCookie,
} from "../lib/impersonation-cookie";

/** Rows of `{ wpId, value }` into a lookup, so the merge below stays O(n). */
function toCountMap(rows: { wpId: string; value: number }[]) {
	return new Map(rows.map((row) => [row.wpId, row.value]));
}

export const superAdminRouter = router({
	/**
	 * Every water purveyor on the platform with its contact, asset,
	 * active-certifier and submitted-test counts.
	 *
	 * Five queries — the purveyors, one grouped aggregate per counted table, and
	 * the WP admins — run in parallel and merged by id. That count is fixed
	 * regardless of how many purveyors come back, so there is no N+1. One query
	 * with three joins would multiply the three one-to-many tables against each
	 * other and inflate every count; correlated subqueries avoid that but
	 * collapse into a single `count` column on the driver's row object, which
	 * silently reads back as zero.
	 *
	 * Reads through the privileged Drizzle connection, so `superAdminProcedure`
	 * is the authorization boundary, not a row policy.
	 */
	listWaterPurveyors: superAdminProcedure.query(async () => {
		const [purveyors, assetRows, certifierRows, submissionRows, adminRows] =
			await Promise.all([
				db
					.select({
						id: waterPurveyors.id,
						companyName: waterPurveyors.companyName,
						pwsid: waterPurveyors.pwsid,
						status: waterPurveyors.status,
						createdAt: waterPurveyors.createdAt,
					})
					.from(waterPurveyors)
					.orderBy(asc(waterPurveyors.companyName)),

				db
					.select({ wpId: bfaAssets.waterPurveyorId, value: count() })
					.from(bfaAssets)
					.groupBy(bfaAssets.waterPurveyorId),

				db
					.select({
						wpId: wpCertifierAuthorizations.waterPurveyorId,
						value: count(),
					})
					.from(wpCertifierAuthorizations)
					.where(eq(wpCertifierAuthorizations.authorizationStatus, "active"))
					.groupBy(wpCertifierAuthorizations.waterPurveyorId),

				db
					.select({ wpId: testSubmissions.waterPurveyorId, value: count() })
					.from(testSubmissions)
					.where(eq(testSubmissions.status, "submitted"))
					.groupBy(testSubmissions.waterPurveyorId),

				// The contact shown per purveyor. `water_purveyors` carries no
				// contact column and `profiles` holds no email — that lives in
				// auth.users — so the WP's own admin is the only name available
				// without a schema change. Blocked admins are skipped: the column
				// answers "who do I reach out to".
				db
					.select({
						wpId: profiles.waterPurveyorId,
						fullName: profiles.fullName,
					})
					.from(profiles)
					.where(
						and(
							eq(profiles.globalRole, "wp_admin"),
							eq(profiles.status, "active"),
						),
					)
					.orderBy(asc(profiles.createdAt), asc(profiles.id)),
			]);

		const assets = toCountMap(assetRows);
		const certifiers = toCountMap(certifierRows);
		const submissions = toCountMap(submissionRows);

		// First admin per purveyor, by the deterministic order above. A WP may
		// have several; the list shows one.
		const contacts = new Map<string, string>();
		for (const row of adminRows) {
			if (!row.wpId || !row.fullName) continue;
			if (!contacts.has(row.wpId)) contacts.set(row.wpId, row.fullName);
		}

		return purveyors.map((purveyor) => ({
			...purveyor,
			// A purveyor with nothing counted has no row in its aggregate.
			assets: assets.get(purveyor.id) ?? 0,
			certifiers: certifiers.get(purveyor.id) ?? 0,
			submissions: submissions.get(purveyor.id) ?? 0,
			// null when the WP has no active admin, or the admin has no name set.
			contact: contacts.get(purveyor.id) ?? null,
		}));
	}),

	/**
	 * Blocks or unblocks one water purveyor. Blocking is a soft state on the row,
	 * never a delete — the purveyor's data stays intact and the switch is
	 * reversible from the same button.
	 *
	 * Super-Admin only, enforced by the procedure: the Drizzle connection is
	 * privileged, so no row policy stands between this and the table.
	 */
	setWaterPurveyorStatus: superAdminProcedure
		.input(
			z.object({
				waterPurveyorId: z.uuid(),
				status: z.enum(["active", "blocked"]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const [row] = await db
				.update(waterPurveyors)
				.set({ status: input.status, updatedAt: new Date() })
				.where(eq(waterPurveyors.id, input.waterPurveyorId))
				.returning({
					id: waterPurveyors.id,
					companyName: waterPurveyors.companyName,
					status: waterPurveyors.status,
				});

			if (!row) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Water purveyor not found",
				});
			}

			// Structured log, same shape as `caller_resolved`. Cheap now, and a
			// tenant being switched off is not something to reconstruct later.
			console.log(
				JSON.stringify({
					event: "water_purveyor_status_changed",
					...auditActorFields(auditActor(ctx)),
					wp_id: row.id,
					status: row.status,
					timestamp: new Date().toISOString(),
				}),
			);

			return row;
		}),

	/**
	 * Starts acting as a water purveyor. The client names the purveyor and
	 * nothing else: which account that means, and whether it may be used, is
	 * decided here from the database — see `findImpersonationTarget`.
	 *
	 * `superAdminProcedure` checks the *effective* caller, so this also refuses a
	 * Super-Admin who is already impersonating: they exit first, rather than
	 * stacking one identity on another.
	 *
	 * The identity goes into its own signed, `httpOnly` cookie. The Supabase
	 * session is not touched — the Super-Admin stays signed in as themselves, and
	 * the cookie is only honoured alongside that session.
	 */
	startImpersonation: superAdminProcedure
		.input(z.object({ waterPurveyorId: z.uuid() }))
		.mutation(async ({ ctx, input }) => {
			const secret = impersonationSecret();
			if (!secret) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Impersonation is not configured on this server",
				});
			}

			const lookup = await findImpersonationTarget(input.waterPurveyorId);

			if (!lookup.ok) {
				switch (lookup.reason) {
					case "wp_not_found":
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Water purveyor not found",
						});
					case "wp_blocked":
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message: "A blocked water purveyor cannot be impersonated",
						});
					case "no_active_admin":
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message:
								"This water purveyor has no active admin account to impersonate",
						});
				}
			}

			const { target } = lookup;
			// Non-null by construction: the lookup joins through the purveyor.
			const waterPurveyorId = target.waterPurveyorId as string;

			const { token, expiresAt } = createImpersonationToken(
				{
					actorProfileId: ctx.actor.profileId,
					targetProfileId: target.profileId,
					waterPurveyorId,
				},
				secret,
			);

			ctx.resHeaders.append("set-cookie", serializeImpersonationCookie(token));

			console.log(
				JSON.stringify({
					event: "impersonation_started",
					actor_id: ctx.actor.profileId,
					target_profile_id: target.profileId,
					target_role: target.globalRole,
					wp_id: waterPurveyorId,
					expires_at: expiresAt.toISOString(),
					timestamp: new Date().toISOString(),
				}),
			);

			return {
				waterPurveyorId,
				waterPurveyorName: target.waterPurveyorName,
				expiresAt,
			};
		}),

	/**
	 * Ends the impersonation and clears the cookie. Checks the real signed-in
	 * account (`superAdminActorProcedure`), because while impersonating the
	 * effective caller is the purveyor's admin.
	 *
	 * Idempotent: a Super-Admin with nothing to end still gets the cookie cleared
	 * and `ended: false`, and no event is logged for an impersonation that did not
	 * exist.
	 */
	endImpersonation: superAdminActorProcedure.mutation(({ ctx }) => {
		ctx.resHeaders.append("set-cookie", serializeClearedImpersonationCookie());

		if (!ctx.impersonation) return { ended: false };

		console.log(
			JSON.stringify({
				event: "impersonation_ended",
				actor_id: ctx.actor.profileId,
				target_profile_id: ctx.impersonation.targetProfileId,
				wp_id: ctx.impersonation.waterPurveyorId,
				reason: "exit",
				timestamp: new Date().toISOString(),
			}),
		);

		return { ended: true };
	}),
});
