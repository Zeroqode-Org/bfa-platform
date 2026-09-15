import { db } from "@bfa-platform/db";
import { repairCompanies } from "@bfa-platform/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import {
	createRepairCompanyInput,
	repairCompanyColumns,
	updateRepairCompanyInput,
} from "../lib/repair-company-input";

/**
 * The columns every repair-company procedure returns. Declared once so the
 * table, the edit form and the mutation responses cannot drift into three
 * shapes of the same row.
 */
const repairCompanySelection = {
	id: repairCompanies.id,
	companyName: repairCompanies.companyName,
	phone: repairCompanies.phone,
	email: repairCompanies.email,
	status: repairCompanies.status,
	createdAt: repairCompanies.createdAt,
	updatedAt: repairCompanies.updatedAt,
};

/**
 * Repair companies are the approved repair firms a water purveyor points a
 * customer at when an assembly fails. They never sign in — the record exists so
 * the failure notice has somewhere to send people.
 *
 * That is the whole reason `status` matters here. The failure workflow resolves
 * the list at send time and takes only `status = 'active'`, so deactivating a
 * company is how a WP stops recommending it. Nothing deletes one: there is no
 * delete procedure below, no delete control on the screen and no DELETE grant
 * in `0005_repair_company_policies`. A notice sent last year named the firms
 * that were approved last year, and a row that can be removed is a record of
 * that which can be made never to have happened.
 *
 * Every statement below reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the `water_purveyor_id` predicate
 * on each query the authorization boundary in the app, and the policies in
 * `0005_repair_company_policies` the same boundary for anything that reaches
 * the table through PostgREST. Neither is a substitute for the other; the RLS
 * suite in `packages/db/src/repair-companies-rls.test.ts` covers the second.
 */
export const repairCompaniesRouter = router({
	/**
	 * Every repair company belonging to the caller's purveyor, A–Z.
	 *
	 * Inactive companies are included. This is the management list, and a
	 * company that vanished from it when it was deactivated could never be
	 * reactivated or corrected. The failure workflow does its own filtering on
	 * `status`; the screen is not that filter.
	 */
	listRepairCompanies: wpProcedure.query(async ({ ctx }) => {
		return (
			db
				.select(repairCompanySelection)
				.from(repairCompanies)
				.where(eq(repairCompanies.waterPurveyorId, ctx.caller.waterPurveyorId))
				// `id` breaks the tie so two companies with the same name keep a
				// stable order between renders rather than swapping places on refetch.
				.orderBy(asc(repairCompanies.companyName), asc(repairCompanies.id))
		);
	}),

	/**
	 * Creates one repair company for the caller's purveyor.
	 *
	 * The tenant comes from `ctx.caller` and nowhere else. There is deliberately
	 * no `waterPurveyorId` on the input: a client cannot ask for another
	 * purveyor's tenant because there is no field in which to ask.
	 */
	createRepairCompany: wpProcedure
		.input(createRepairCompanyInput)
		.mutation(async ({ ctx, input }) => {
			const [row] = await db
				.insert(repairCompanies)
				.values({
					...repairCompanyColumns(input),
					waterPurveyorId: ctx.caller.waterPurveyorId,
				})
				.returning(repairCompanySelection);

			if (!row) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Repair company insert returned no row",
				});
			}

			logRepairCompanyEvent("repair_company_created", {
				actor: auditActor(ctx),
				repairCompanyId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { status: row.status },
			});

			return row;
		}),

	/**
	 * Updates one repair company. The whole record is sent, so an omitted
	 * optional field is a field being cleared.
	 *
	 * Both the id *and* the caller's purveyor are in the predicate. Scoping by id
	 * alone would let a guessed or leaked uuid from another tenant be written
	 * through this privileged connection; with the tenant in the `where`, a
	 * cross-WP id matches no row and comes back as a not-found rather than as a
	 * silent success — the read before the write is scoped the same way, so a
	 * foreign row cannot even be observed.
	 */
	updateRepairCompany: wpProcedure
		.input(updateRepairCompanyInput)
		.mutation(async ({ ctx, input }) => {
			const tenantScopedRow = and(
				eq(repairCompanies.id, input.id),
				eq(repairCompanies.waterPurveyorId, ctx.caller.waterPurveyorId),
			);

			// Read first, for two reasons. The previous status, because deactivation
			// has a consequence beyond this table — it drops the company out of
			// every future failure notice — so it gets its own audit line rather
			// than hiding inside a generic update. And the rest of the row, for the
			// comparison below.
			const [existing] = await db
				.select(repairCompanySelection)
				.from(repairCompanies)
				.where(tenantScopedRow)
				.limit(1);

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Repair company not found",
				});
			}

			const next = repairCompanyColumns(input);

			// Opening the edit dialog and pressing save without touching a field is
			// not an update, and writing one anyway would make two records lie.
			// `updated_at` would come to mean "when somebody last pressed save"
			// rather than when the row last changed, and the audit trail would carry
			// a `repair_company_updated` line for a modification that never
			// happened — the one thing an audit trail must not do.
			//
			// The whole record is sent on every save, so this is the only place that
			// can tell the difference. Returning `existing` is honest: it is what
			// the row holds, and it is what the client asked for.
			if (isUnchanged(existing, next)) {
				return existing;
			}

			const [row] = await db
				.update(repairCompanies)
				.set({ ...next, updatedAt: new Date() })
				.where(tenantScopedRow)
				.returning(repairCompanySelection);

			if (!row) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Repair company not found",
				});
			}

			logRepairCompanyEvent("repair_company_updated", {
				actor: auditActor(ctx),
				repairCompanyId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { status: row.status },
			});

			if (existing.status !== row.status) {
				logRepairCompanyEvent("repair_company_status_changed", {
					actor: auditActor(ctx),
					repairCompanyId: row.id,
					waterPurveyorId: ctx.caller.waterPurveyorId,
					extra: { from: existing.status, to: row.status },
				});
			}

			return row;
		}),
});

/**
 * Whether every writable column already holds the value being written.
 *
 * Driven off `repairCompanyColumns`' own keys rather than a hand-written list
 * of comparisons, so a column added to the write set is compared here too
 * instead of quietly becoming a field that a no-op save keeps rewriting.
 *
 * Every value involved is a string, an enum or null, so `===` is the whole
 * comparison. A future column holding an object or a Date would need more.
 */
function isUnchanged(
	existing: Record<string, unknown>,
	next: ReturnType<typeof repairCompanyColumns>,
) {
	return Object.entries(next).every(
		([column, value]) => existing[column] === value,
	);
}

/**
 * One structured JSON line per sensitive write, in the same shape as
 * `customer_created` and `caller_resolved`. A string log would not be greppable
 * by tenant, which is the whole point of carrying `wp_id`.
 */
function logRepairCompanyEvent(
	event: string,
	{
		actor,
		repairCompanyId,
		waterPurveyorId,
		extra,
	}: {
		actor: AuditActor;
		repairCompanyId: string;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			repair_company_id: repairCompanyId,
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
