import { db } from "@bfa-platform/db";
import {
	certifiers,
	profiles,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { router, TRPCError, wpProcedure } from "../index";
import { auditActor, auditActorFields } from "../lib/audit-actor";

/**
 * The columns the certifiers screen reads. Declared once so the list and the
 * status mutation cannot drift into two shapes of the same row. Every query
 * using it joins `wp_certifier_authorizations` on the caller's purveyor.
 *
 * `fullName` comes from `profiles`, not from `certifiers` — a certifier's name
 * is their account's name and lives in one place. Everything else on the row is
 * their professional identity, which is the certifier's own to maintain.
 *
 * `status` is this purveyor's block, read off its own authorization row: a
 * revoked authorization is what "blocked" means on this screen. Any other
 * purveyor's choice, and the account itself, are not this screen's to show.
 */
const certifierSelection = {
	id: certifiers.id,
	fullName: profiles.fullName,
	company: certifiers.company,
	idNumber: certifiers.idNumber,
	licenseExpirationDate: certifiers.licenseExpirationDate,
	status: sql<
		"active" | "blocked"
	>`case when ${wpCertifierAuthorizations.authorizationStatus} = 'revoked' then 'blocked' else 'active' end`,
};

/**
 * The two administrative WP roles, for one named action — the wording of the
 * refusal says which.
 *
 * Deliberately local to this router rather than a shared procedure in
 * `../index`. The SubAdmin/Employee split is an open question project-wide
 * (PRD § 10), and the one thing confirmed about it here is narrow: all three
 * roles list and invite certifiers, and blocking is not clerk work. A shared
 * `wpAdminProcedure` would read as a project-wide policy, and the next feature
 * that reached for it would be settling that question by accident.
 */
function wpAdministrativeProcedure(action: string) {
	return wpProcedure.use(({ ctx, next }) => {
		if (
			ctx.caller.globalRole !== "wp_admin" &&
			ctx.caller.globalRole !== "wp_sub_admin"
		) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: `Only a WP Admin or SubAdmin can ${action}`,
			});
		}

		return next({ ctx });
	});
}

const setCertifierStatusInput = z.strictObject({
	id: z.uuid(),
	status: z.enum(["active", "blocked"]),
});

const setCertifierTypeInput = z.strictObject({
	id: z.uuid(),
	certifierType: z.enum(["internal", "external"]),
});

/**
 * The certifiers a water purveyor works with, and the one thing a purveyor may
 * change about them.
 *
 * A certifier is not a tenant of a purveyor. They hold one `certifiers` row and
 * one account no matter how many purveyors they serve, and the relationship
 * lives in `wp_certifier_authorizations` — which is why every query below joins
 * through it rather than comparing a `water_purveyor_id` column that this table
 * does not have. A certifier authorized by two purveyors appears on both
 * screens, and blocking them from one leaves the other untouched.
 *
 * The purveyor owns exactly one column here: `status`. Name, company, licence
 * number and expiry are the certifier's own record, maintained by them, and
 * `setCertifierStatus` cannot write any of them — its input has no field for
 * them and the UPDATE names one column. `0007_certifier_column_permissions`
 * enforces the same split for anything arriving through PostgREST.
 *
 * Blocking is **per purveyor** (client, 2026-11-02): it revokes this
 * purveyor's `wp_certifier_authorizations` row and leaves the account alone,
 * so a certifier who also works for others keeps signing in and keeps that
 * work. Everything a certifier does for a purveyor already requires an
 * `active` authorization — the WP selector, `assertAuthorizedWp` behind the
 * wizard, and the reminder workflow's recipients — so a revoked row is enough
 * to close this purveyor's door.
 *
 * `certifiers.status` — the account-wide switch the login gate reads — is no
 * longer written from here. It used to be; migration 0023 moved those blocks
 * onto the authorizations. See `/docs/wp-certifiers`.
 *
 * Every statement below reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the authorization join the
 * authorization boundary in the app, and the policies in
 * `0006_certifier_policies` the same boundary for anything that reaches the
 * table through PostgREST. Neither substitutes for the other; the RLS suite in
 * `packages/db/src/certifiers-rls.test.ts` covers the second.
 */
export const certifiersRouter = router({
	/**
	 * Every certifier authorized for the caller's purveyor, by name.
	 *
	 * All three WP roles may read it. A certifier and a Super-Admin are refused
	 * by `wpProcedure` rather than handed an empty list — a Super-Admin has no
	 * purveyor to scope this to, and the cross-tenant view is a different screen.
	 */
	listWpCertifiers: wpProcedure.query(async ({ ctx }) => {
		return (
			db
				.select({
					...certifierSelection,
					// Internal or external is this purveyor's own word about the
					// certifier, so it comes off this purveyor's authorization row —
					// the same certifier may carry the other type somewhere else.
					certifierType: wpCertifierAuthorizations.certifierType,
				})
				.from(certifiers)
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.innerJoin(
					wpCertifierAuthorizations,
					eq(wpCertifierAuthorizations.certifierId, certifiers.id),
				)
				.where(
					eq(
						wpCertifierAuthorizations.waterPurveyorId,
						ctx.caller.waterPurveyorId,
					),
				)
				// `id` breaks the tie so two certifiers with the same name keep a
				// stable order between renders rather than swapping places on refetch.
				.orderBy(asc(profiles.fullName), asc(certifiers.id))
		);
	}),

	/**
	 * Blocks or unblocks one certifier for the caller's purveyor. Writes this
	 * purveyor's `authorization_status` — `revoked` or `active` — and nothing
	 * else.
	 *
	 * The input is a strict object, so a client that sends `company` alongside
	 * `status` is refused rather than quietly having it dropped. That is the
	 * difference worth having: a silently ignored field looks like a successful
	 * edit to whatever sent it. The UPDATE names one column for the same reason
	 * the grant in `0006_certifier_policies` hands over one.
	 *
	 * The target is scoped through the caller's own authorizations, not by id.
	 * A certifier id from a purveyor the caller does not work with matches no
	 * row and comes back as a not-found — it cannot be read here, and it cannot
	 * be written.
	 */
	setCertifierStatus: wpAdministrativeProcedure("block a certifier")
		.input(setCertifierStatusInput)
		.mutation(async ({ ctx, input }) => {
			// The caller's own authorization row is both the scope and the target:
			// `certifiers` has no tenant column, so this table is the only place
			// the caller's reach is written down.
			const ownAuthorization = and(
				eq(wpCertifierAuthorizations.certifierId, input.id),
				eq(
					wpCertifierAuthorizations.waterPurveyorId,
					ctx.caller.waterPurveyorId,
				),
			);

			// Read and write in one transaction, with the authorization row
			// locked, so two admins pressing Block at once serialise: the second
			// reads the first one's result and is a no-op instead of a second
			// audit line for the same transition.
			const result = await db.transaction(async (tx) => {
				// Read first, for the previous status. It is what the audit line
				// needs, and it is what tells a real transition from a request that
				// asks for the value the row already holds.
				const [existing] = await tx
					.select({
						...certifierSelection,
						authorizationStatus: wpCertifierAuthorizations.authorizationStatus,
					})
					.from(certifiers)
					.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
					.innerJoin(
						wpCertifierAuthorizations,
						eq(wpCertifierAuthorizations.certifierId, certifiers.id),
					)
					.where(ownAuthorization)
					.limit(1)
					.for("update", { of: wpCertifierAuthorizations });

				if (!existing) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Certifier not found",
					});
				}

				const { authorizationStatus, ...row } = existing;

				// Blocking a certifier who is already blocked is not a change.
				// Writing anyway would put a `certifier_status_changed` line with
				// `from` equal to `to` in the audit trail, which is the one thing an
				// audit trail must not do.
				//
				// Returning the row is honest: it is what the row holds, and it is
				// what the caller asked for.
				if (row.status === input.status) {
					return { row, changed: false };
				}

				// Only `active` ⇄ `revoked`. A `pending` authorization reads as
				// active on this screen, and blocking then unblocking it would
				// otherwise promote it to `active` without the invitation ever being
				// accepted.
				if (authorizationStatus === "pending") {
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"This certifier has not accepted their invitation yet, so there is nothing to block.",
					});
				}

				await tx
					.update(wpCertifierAuthorizations)
					.set({
						authorizationStatus:
							input.status === "blocked" ? "revoked" : "active",
					})
					.where(ownAuthorization);

				return { row, changed: true };
			});

			if (!result.changed) return result.row;

			const existing = result.row;

			// One structured JSON line per status change, in the same shape as
			// `repair_company_status_changed` and `caller_resolved`. A string log
			// would not be greppable by tenant, which is the whole point of `wp_id`.
			console.log(
				JSON.stringify({
					event: "certifier_status_changed",
					...auditActorFields(auditActor(ctx)),
					certifier_id: existing.id,
					wp_id: ctx.caller.waterPurveyorId,
					from: existing.status,
					to: input.status,
					scope: "water_purveyor",
					timestamp: new Date().toISOString(),
				}),
			);

			return { ...existing, status: input.status };
		}),

	/**
	 * Moves one certifier between this purveyor's Internal and External tabs.
	 *
	 * Writes `wp_certifier_authorizations.certifier_type` on the caller's own
	 * authorization row and nothing else — the type is per purveyor, so another
	 * purveyor that works with the same certifier keeps whatever it chose. The
	 * row is found by certifier id *and* the caller's purveyor, so a certifier
	 * this purveyor does not work with is a not-found, exactly as for blocking.
	 *
	 * Admin and SubAdmin only, like blocking: it decides which list a certifier
	 * is filed under, which is not clerk work.
	 */
	setCertifierType: wpAdministrativeProcedure(
		"change whether a certifier is internal or external",
	)
		.input(setCertifierTypeInput)
		.mutation(async ({ ctx, input }) => {
			const ownAuthorization = and(
				eq(wpCertifierAuthorizations.certifierId, input.id),
				eq(
					wpCertifierAuthorizations.waterPurveyorId,
					ctx.caller.waterPurveyorId,
				),
			);

			const [existing] = await db
				.select({
					id: certifiers.id,
					fullName: profiles.fullName,
					certifierType: wpCertifierAuthorizations.certifierType,
				})
				.from(wpCertifierAuthorizations)
				.innerJoin(
					certifiers,
					eq(certifiers.id, wpCertifierAuthorizations.certifierId),
				)
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(ownAuthorization)
				.limit(1);

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Certifier not found",
				});
			}

			// Not a change, so not a write and not an audit line — the same rule
			// `setCertifierStatus` follows, for the same reasons.
			if (existing.certifierType === input.certifierType) {
				return existing;
			}

			const [updated] = await db
				.update(wpCertifierAuthorizations)
				.set({ certifierType: input.certifierType })
				.where(ownAuthorization)
				.returning({ certifierType: wpCertifierAuthorizations.certifierType });

			if (!updated) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Certifier not found",
				});
			}

			console.log(
				JSON.stringify({
					event: "certifier_type_changed",
					...auditActorFields(auditActor(ctx)),
					certifier_id: existing.id,
					wp_id: ctx.caller.waterPurveyorId,
					from: existing.certifierType,
					to: updated.certifierType,
					timestamp: new Date().toISOString(),
				}),
			);

			return { ...existing, certifierType: updated.certifierType };
		}),
});
