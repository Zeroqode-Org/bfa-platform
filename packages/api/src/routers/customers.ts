import { db } from "@bfa-platform/db";
import { customers } from "@bfa-platform/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import {
	createCustomerInput,
	customerColumns,
	updateCustomerInput,
} from "../lib/customer-input";
import { CUSTOMER_STALE_MESSAGE } from "../lib/customer-revision";
import {
	CUSTOMER_EMAIL_TAKEN_MESSAGE,
	CUSTOMER_EMAIL_UNIQUE_INDEX,
} from "../lib/email-uniqueness";
import { isUniqueViolation } from "../lib/unique-violation";
import { reconcileAgRenewalNotice } from "../scheduler/ag-renewal";

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
	// The version the client must send back to edit this record. Part of every
	// response because the edit form is opened from a list row.
	revision: customers.revision,
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
	 *
	 * An agricultural customer's AG renewal notice (Workflow 2) is queued in the
	 * same transaction as the insert, so a customer that fails to save never
	 * leaves a job behind to mail them.
	 */
	createCustomer: wpProcedure
		.input(createCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const row = await db.transaction(async (tx) => {
				// No "is this address taken?" read first: the unique index decides, so
				// two clerks adding the same address at once cannot both succeed.
				const [inserted] = await tx
					.insert(customers)
					.values({
						...customerColumns(input),
						waterPurveyorId: ctx.caller.waterPurveyorId,
					})
					.returning(customerSelection)
					.catch((error: unknown) => {
						throw duplicateEmailError(error);
					});

				if (!inserted) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Customer insert returned no row",
					});
				}

				if (inserted.rateCategory === "agricultural") {
					await reconcileAgRenewalNotice({
						executor: tx,
						customerId: inserted.id,
						waterPurveyorId: ctx.caller.waterPurveyorId,
						rateCategory: inserted.rateCategory,
						agRenewalDate: inserted.agRenewalDate,
						actor: auditActor(ctx),
						trigger: "customer_created",
					});
				}

				return inserted;
			});

			logCustomerEvent("customer_created", {
				actor: auditActor(ctx),
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
	 *
	 * The read, the write and the AG renewal reconciliation share one
	 * transaction, and the read takes the row lock. Two clerks saving the same
	 * customer at once therefore serialise, and each compares against the row
	 * the other committed — without that, a save that only renamed the customer
	 * could restore an old renewal date while the notice stayed scheduled for
	 * the new one.
	 *
	 * Serialising is not enough on its own, though, because the form submits
	 * the whole record from whenever it was opened. A real change is therefore
	 * refused unless `expectedRevision` still matches the row — see
	 * `lib/customer-revision.ts` — and every accepted change bumps it. The
	 * scheduler's annual transition bumps it too, so the one case this exists
	 * for is covered: a form opened before the AG renewal date moved on a year
	 * cannot put the old date back and queue a second email.
	 */
	updateCustomer: wpProcedure
		.input(updateCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const tenantScopedRow = and(
				eq(customers.id, input.id),
				eq(customers.waterPurveyorId, ctx.caller.waterPurveyorId),
			);

			const { existing, row } = await db.transaction(async (tx) => {
				// Read first, for two reasons. The previous status, because
				// suspension has a consequence beyond this table — it holds the
				// notice pipeline for every asset currently attached to the
				// customer — so it gets its own audit line rather than hiding inside
				// a generic update. And the rest of the row, for the comparison below.
				const [current] = await tx
					.select(customerSelection)
					.from(customers)
					.where(tenantScopedRow)
					.limit(1)
					.for("update");

				if (!current) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Customer not found",
					});
				}

				const next = customerColumns(input);

				// Opening the edit dialog and pressing save without touching a field
				// is not an update, and writing one anyway would make two records
				// lie. `updated_at` would come to mean "when somebody last pressed
				// save" rather than when the row last changed, and the audit trail
				// would carry a `customer_updated` line for a modification that never
				// happened — the one thing an audit trail must not do.
				//
				// The whole record is sent on every save, so this is the only place
				// that can tell the difference. Returning the row as it is is honest:
				// it is what the row holds, and it is what the client asked for.
				if (isUnchanged(current, next)) {
					return { existing: current, row: null };
				}

				// Only now, because a save that changes nothing is not a conflict
				// with anything: there is no edit to lose, and returning the row as
				// it stands is both true and what the client asked for.
				if (current.revision !== input.expectedRevision) {
					throw new TRPCError({
						code: "CONFLICT",
						message: CUSTOMER_STALE_MESSAGE,
					});
				}

				// An edit onto another customer's address is refused by the same
				// index. The record's own address never collides with itself, so
				// saving a customer without changing their email is unaffected.
				const [updated] = await tx
					.update(customers)
					.set({
						...next,
						revision: sql`${customers.revision} + 1`,
						updatedAt: new Date(),
					})
					// The revision is in the predicate as well as checked above, so the
					// statement itself can never write over a version it did not read.
					.where(
						and(
							tenantScopedRow,
							eq(customers.revision, input.expectedRevision),
						),
					)
					.returning(customerSelection)
					.catch((error: unknown) => {
						throw duplicateEmailError(error);
					});

				if (!updated) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Customer not found",
					});
				}

				// Only a change to what the renewal notice hangs off reaches the
				// scheduler: a renamed customer keeps the job they have, and a notice
				// already sent for an unchanged date is not queued again.
				if (
					current.rateCategory !== updated.rateCategory ||
					current.agRenewalDate !== updated.agRenewalDate
				) {
					await reconcileAgRenewalNotice({
						executor: tx,
						customerId: updated.id,
						waterPurveyorId: ctx.caller.waterPurveyorId,
						rateCategory: updated.rateCategory,
						agRenewalDate: updated.agRenewalDate,
						actor: auditActor(ctx),
						trigger: "customer_updated",
					});
				}

				return { existing: current, row: updated };
			});

			if (!row) return existing;

			logCustomerEvent("customer_updated", {
				actor: auditActor(ctx),
				customerId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { rate_category: row.rateCategory, status: row.status },
			});

			if (existing.status !== row.status) {
				logCustomerEvent("customer_status_changed", {
					actor: auditActor(ctx),
					customerId: row.id,
					waterPurveyorId: ctx.caller.waterPurveyorId,
					extra: { from: existing.status, to: row.status },
				});
			}

			return row;
		}),
});

/**
 * A duplicate email, as the Email field's error.
 *
 * `CONFLICT` is the one code these procedures raise for a field, so the form
 * can route it by code rather than by matching the sentence. Only a violation
 * of the email index is translated; anything else is rethrown untouched.
 */
function duplicateEmailError(error: unknown) {
	if (!isUniqueViolation(error, CUSTOMER_EMAIL_UNIQUE_INDEX)) return error;

	return new TRPCError({
		code: "CONFLICT",
		message: CUSTOMER_EMAIL_TAKEN_MESSAGE,
		cause: error,
	});
}

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
		actor,
		customerId,
		waterPurveyorId,
		extra,
	}: {
		actor: AuditActor;
		customerId: string;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			customer_id: customerId,
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
