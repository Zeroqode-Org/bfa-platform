import { db } from "@bfa-platform/db";
import { customers } from "@bfa-platform/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import {
	createCustomerInput,
	customerColumns,
	updateCustomerInput,
} from "../lib/customer-input";

/**
 * The columns every customer procedure returns. Declared once so the table, the
 * edit form and the mutation responses cannot drift into three shapes of the
 * same row.
 */
const customerSelection = {
	id: customers.id,
	accountNumber: customers.accountNumber,
	name: customers.name,
	address: customers.address,
	email: customers.email,
	rateCategory: customers.rateCategory,
	agRenewalDate: customers.agRenewalDate,
	status: customers.status,
	createdAt: customers.createdAt,
	updatedAt: customers.updatedAt,
};

/**
 * Customers are managed entirely by their water purveyor — they never sign in,
 * so there is no self-service path to any of this and no customer-facing
 * procedure to keep in step.
 *
 * Every statement below reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the `water_purveyor_id` predicate
 * on each query the authorization boundary in the app, and the policies in
 * `0003_customer_policies` the same boundary for anything that reaches the
 * table through PostgREST. Neither is a substitute for the other; the RLS suite
 * in `packages/db/src/customers-rls.test.ts` covers the second.
 */
export const customersRouter = router({
	/** Every customer belonging to the caller's purveyor, A–Z. */
	listCustomers: wpProcedure.query(async ({ ctx }) => {
		return (
			db
				.select(customerSelection)
				.from(customers)
				.where(eq(customers.waterPurveyorId, ctx.caller.waterPurveyorId))
				// `id` breaks the tie so two customers with the same name keep a stable
				// order between renders rather than swapping places on refetch.
				.orderBy(asc(customers.name), asc(customers.id))
		);
	}),

	/**
	 * Creates one customer for the caller's purveyor.
	 *
	 * The tenant comes from `ctx.caller` and nowhere else. There is deliberately
	 * no `waterPurveyorId` on the input: a client cannot ask for another
	 * purveyor's tenant because there is no field in which to ask.
	 */
	createCustomer: wpProcedure
		.input(createCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const [row] = await db
				.insert(customers)
				.values({
					...customerColumns(input),
					waterPurveyorId: ctx.caller.waterPurveyorId,
				})
				.returning(customerSelection);

			if (!row) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Customer insert returned no row",
				});
			}

			logCustomerEvent("customer_created", {
				actorId: ctx.caller.profileId,
				customerId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { rate_category: row.rateCategory, status: row.status },
			});

			return row;
		}),

	/**
	 * Updates one customer. The whole record is sent, so an omitted optional
	 * field is a field being cleared.
	 *
	 * Both the id *and* the caller's purveyor are in the predicate. Scoping by id
	 * alone would let a guessed or leaked uuid from another tenant be written
	 * through this privileged connection; with the tenant in the `where`, a
	 * cross-WP id matches no row and comes back as a not-found rather than as a
	 * silent success — the read before the write is scoped the same way, so a
	 * foreign row cannot even be observed.
	 */
	updateCustomer: wpProcedure
		.input(updateCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const tenantScopedRow = and(
				eq(customers.id, input.id),
				eq(customers.waterPurveyorId, ctx.caller.waterPurveyorId),
			);

			// Read first, for two reasons. The previous status, because suspension
			// has a consequence beyond this table — it holds the notice pipeline for
			// every asset currently attached to the customer — so it gets its own
			// audit line rather than hiding inside a generic update. And the rest of
			// the row, for the comparison below.
			const [existing] = await db
				.select(customerSelection)
				.from(customers)
				.where(tenantScopedRow)
				.limit(1);

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Customer not found",
				});
			}

			const next = customerColumns(input);

			// Opening the edit dialog and pressing save without touching a field is
			// not an update, and writing one anyway would make two records lie.
			// `updated_at` would come to mean "when somebody last pressed save"
			// rather than when the row last changed, and the audit trail would
			// carry a `customer_updated` line for a modification that never
			// happened — the one thing an audit trail must not do.
			//
			// The whole record is sent on every save, so this is the only place
			// that can tell the difference. Returning `existing` is honest: it is
			// what the row holds, and it is what the client asked for.
			if (isUnchanged(existing, next)) {
				return existing;
			}

			const [row] = await db
				.update(customers)
				.set({ ...next, updatedAt: new Date() })
				.where(tenantScopedRow)
				.returning(customerSelection);

			if (!row) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Customer not found",
				});
			}

			logCustomerEvent("customer_updated", {
				actorId: ctx.caller.profileId,
				customerId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { rate_category: row.rateCategory, status: row.status },
			});

			if (existing.status !== row.status) {
				logCustomerEvent("customer_status_changed", {
					actorId: ctx.caller.profileId,
					customerId: row.id,
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
 * Driven off `customerColumns`' own keys rather than a hand-written list of
 * comparisons, so a column added to the write set is compared here too instead
 * of quietly becoming a field that a no-op save keeps rewriting.
 *
 * Every value involved is a string, an enum or null — `date` columns come back
 * from the driver as `YYYY-MM-DD` strings — so `===` is the whole comparison.
 * A future column holding an object or a Date would need more than this.
 */
function isUnchanged(
	existing: Record<string, unknown>,
	next: ReturnType<typeof customerColumns>,
) {
	return Object.entries(next).every(
		([column, value]) => existing[column] === value,
	);
}

/**
 * One structured JSON line per sensitive write, in the same shape as
 * `caller_resolved` and `water_purveyor_status_changed`. A string log would not
 * be greppable by tenant, which is the whole point of carrying `wp_id`.
 */
function logCustomerEvent(
	event: string,
	{
		actorId,
		customerId,
		waterPurveyorId,
		extra,
	}: {
		actorId: string;
		customerId: string;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			actor_id: actorId,
			customer_id: customerId,
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
