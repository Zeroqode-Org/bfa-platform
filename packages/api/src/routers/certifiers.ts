import { db } from "@bfa-platform/db";
import {
	certifiers,
	profiles,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { router, TRPCError, wpProcedure } from "../index";

/**
 * The columns the certifiers screen reads. Declared once so the list and the
 * status mutation cannot drift into two shapes of the same row.
 *
 * `fullName` comes from `profiles`, not from `certifiers` — a certifier's name
 * is their account's name and lives in one place. Everything else on the row is
 * their professional identity, which is the certifier's own to maintain.
 */
const certifierSelection = {
	id: certifiers.id,
	fullName: profiles.fullName,
	company: certifiers.company,
	idNumber: certifiers.idNumber,
	licenseExpirationDate: certifiers.licenseExpirationDate,
	status: certifiers.status,
};

/**
 * The two administrative WP roles.
 *
 * Deliberately local to this router rather than a shared procedure in
 * `../index`. The SubAdmin/Employee split is an open question project-wide
 * (PRD § 10), and the one thing confirmed about it here is narrow: all three
 * roles list and invite certifiers, and blocking is not clerk work. A shared
 * `wpAdminProcedure` would read as a project-wide policy, and the next feature
 * that reached for it would be settling that question by accident.
 */
const wpStatusWriterProcedure = wpProcedure.use(({ ctx, next }) => {
	if (
		ctx.caller.globalRole !== "wp_admin" &&
		ctx.caller.globalRole !== "wp_sub_admin"
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only a WP Admin or SubAdmin can block a certifier",
		});
	}

	return next({ ctx });
});

const setCertifierStatusInput = z.strictObject({
	id: z.uuid(),
	status: z.enum(["active", "blocked"]),
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
 * screens; blocking them from one blocks them from the platform, which is why
 * the screen says so before it does it.
 *
 * The purveyor owns exactly one column here: `status`. Name, company, licence
 * number and expiry are the certifier's own record, maintained by them, and
 * `setCertifierStatus` cannot write any of them — its input has no field for
 * them and the UPDATE names one column. `0007_certifier_column_permissions`
 * enforces the same split for anything arriving through PostgREST.
 *
 * `certifiers.status` is **global, not per-purveyor**. There is one column on
 * one row, so a purveyor blocking a certifier who also works for two others
 * removes that person's access to the platform entirely, including the jobs
 * those other purveyors depend on them for. That is what the build plan's
 * acceptance criterion asks for — "blocking a certifier prevents their login" —
 * and what `certifiers.status`' own schema comment says it means.
 *
 * The per-purveyor alternative exists in the schema and is deliberately not
 * what this procedure writes: `wp_certifier_authorizations.authorization_status`
 * has a `revoked` value, and revoking it would end one relationship while
 * leaving the account alone. It belongs to authorization management, which is
 * a separate feature — and the reminder workflow already reads the two columns
 * as different things, filtering on `authorization_status = 'active'` AND
 * `certifiers.status = 'active'`. Blocking and revoking are two products, and
 * this screen ships the first. See `/docs/wp-certifiers`.
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
				.select(certifierSelection)
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
	 * Blocks or unblocks one certifier. Writes `certifiers.status` and nothing
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
	setCertifierStatus: wpStatusWriterProcedure
		.input(setCertifierStatusInput)
		.mutation(async ({ ctx, input }) => {
			// The subquery, not `ctx.caller.waterPurveyorId` on a column, is what
			// scopes this: `certifiers` has no tenant column, so the authorization
			// table is the only place the caller's reach is written down.
			const authorizedCertifierIds = db
				.select({ certifierId: wpCertifierAuthorizations.certifierId })
				.from(wpCertifierAuthorizations)
				.where(
					eq(
						wpCertifierAuthorizations.waterPurveyorId,
						ctx.caller.waterPurveyorId,
					),
				);

			const tenantScopedRow = and(
				eq(certifiers.id, input.id),
				inArray(certifiers.id, authorizedCertifierIds),
			);

			// Read first, for the previous status. It is what the audit line needs,
			// and it is what tells a real transition from a request that asks for
			// the value the row already holds.
			const [existing] = await db
				.select(certifierSelection)
				.from(certifiers)
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(tenantScopedRow)
				.limit(1);

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Certifier not found",
				});
			}

			// Blocking a certifier who is already blocked is not a change. Writing
			// anyway would make two records lie: `updated_at` — maintained by the
			// `set_updated_at` trigger, so any UPDATE at all moves it — would come
			// to mean "when somebody last pressed the button", and the audit trail
			// would carry a `certifier_status_changed` line with `from` equal to
			// `to`, which is the one thing an audit trail must not do.
			//
			// Returning `existing` is honest: it is what the row holds, and it is
			// what the caller asked for.
			if (existing.status === input.status) {
				return existing;
			}

			const [updated] = await db
				.update(certifiers)
				.set({ status: input.status })
				.where(tenantScopedRow)
				.returning({ status: certifiers.status });

			if (!updated) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Certifier not found",
				});
			}

			// One structured JSON line per status change, in the same shape as
			// `repair_company_status_changed` and `caller_resolved`. A string log
			// would not be greppable by tenant, which is the whole point of `wp_id`
			// — and this is the event that takes somebody's platform access away.
			console.log(
				JSON.stringify({
					event: "certifier_status_changed",
					actor_id: ctx.caller.profileId,
					certifier_id: existing.id,
					wp_id: ctx.caller.waterPurveyorId,
					from: existing.status,
					to: updated.status,
					timestamp: new Date().toISOString(),
				}),
			);

			return { ...existing, status: updated.status };
		}),
});
