import { db } from "@bfa-platform/db";
import { bfaAssets, customers } from "@bfa-platform/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import { attachCustomerToAsset } from "../lib/customer-assignment";
import {
	CUSTOMER_BIN_NOT_FOUND_MESSAGE,
	CUSTOMER_BIN_REQUIRED_MESSAGE,
	customerBinReassignMessage,
} from "../lib/customer-bin";
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
import type { JobExecutor } from "../scheduler/jobs";

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
 * The BINs of the assets this customer currently occupies, A–Z — what the
 * customer form lists as already attached. Read from the assets' live pointer,
 * the same one every notice is addressed through, and only within the
 * customer's own purveyor, so a corrupt cross-tenant pointer cannot surface
 * another WP's BIN here.
 *
 * Written with explicit qualifiers rather than interpolated columns on
 * purpose. Drizzle renders a column unqualified in a single-table select, so
 * `${customers.id}` inside the subquery became a bare `"id"` — which resolves
 * to the *asset's* id, comparing the asset with itself and returning an empty
 * list for every customer.
 */
const heldBins = sql<string[]>`coalesce((
	select array_agg(held.bin order by held.bin)
	from bfa_assets held
	where held.current_customer_id = "customers"."id"
	  and held.water_purveyor_id = "customers"."water_purveyor_id"
), '{}')`;

/** What every procedure returns: the row plus the BINs attached to it. */
const customerWithBinsSelection = { ...customerSelection, bins: heldBins };

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
				.select(customerWithBinsSelection)
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
	 *
	 * A new customer must name the BIN of an asset to occupy — a customer
	 * attached to nothing is a record no notice can reach — and the attachment
	 * shares the insert's transaction, so a BIN that cannot be honoured leaves
	 * no customer behind either.
	 */
	createCustomer: wpProcedure
		.input(createCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const attachBin = input.attachBin;

			if (!attachBin) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: CUSTOMER_BIN_REQUIRED_MESSAGE,
				});
			}

			const { row, attached } = await db.transaction(async (tx) => {
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

				const attachment = await attachByBin({
					executor: tx,
					waterPurveyorId: ctx.caller.waterPurveyorId,
					customer: inserted,
					bin: attachBin,
					acknowledgeReassign: input.acknowledgeReassign ?? false,
					actor: auditActor(ctx),
				});

				return { row: inserted, attached: attachment };
			});

			logCustomerEvent("customer_created", {
				actor: auditActor(ctx),
				customerId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { rate_category: row.rateCategory, status: row.status },
			});
			if (attached) {
				logAssignment(
					auditActor(ctx),
					ctx.caller.waterPurveyorId,
					row,
					attached,
				);
			}

			return readCustomer(ctx.caller.waterPurveyorId, row.id);
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
	 *
	 * `attachBin` rides in the same transaction. Attaching is not a change to
	 * the customer row — it moves an asset's pointer — so it neither needs the
	 * revision check nor bumps the revision, and a save that only attaches a
	 * BIN is still a no-op for the row itself. A customer who holds no asset
	 * must name one, so a record no notice can reach is not saved as though it
	 * were complete.
	 */
	updateCustomer: wpProcedure
		.input(updateCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const tenantScopedRow = and(
				eq(customers.id, input.id),
				eq(customers.waterPurveyorId, ctx.caller.waterPurveyorId),
			);

			const { existing, row, attached } = await db.transaction(async (tx) => {
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

				const attachBin = input.attachBin;
				const attachment = attachBin
					? await attachByBin({
							executor: tx,
							waterPurveyorId: ctx.caller.waterPurveyorId,
							customer: current,
							bin: attachBin,
							acknowledgeReassign: input.acknowledgeReassign ?? false,
							actor: auditActor(ctx),
						})
					: await requireHeldAsset(tx, current.id, ctx.caller.waterPurveyorId);

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
					return { existing: current, row: null, attached: attachment };
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

				return { existing: current, row: updated, attached: attachment };
			});

			if (attached) {
				logAssignment(
					auditActor(ctx),
					ctx.caller.waterPurveyorId,
					row ?? existing,
					attached,
				);
			}

			if (!row) return readCustomer(ctx.caller.waterPurveyorId, existing.id);

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

			return readCustomer(ctx.caller.waterPurveyorId, row.id);
		}),
});

/**
 * One customer of the caller's purveyor, as every procedure returns it.
 *
 * Read after the transaction rather than taken from `returning`: the BINs it
 * carries are only final once the attachment in the same save has landed.
 */
async function readCustomer(waterPurveyorId: string, customerId: string) {
	const [row] = await db
		.select(customerWithBinsSelection)
		.from(customers)
		.where(
			and(
				eq(customers.id, customerId),
				eq(customers.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
	}

	return row;
}

/** What an attachment did, for its audit line. */
type Attachment = { assetId: string; bin: string; from: string | null };

/**
 * Attaches the customer to the caller's own asset with this BIN, inside the
 * caller's transaction.
 *
 * The asset is looked up inside the caller's purveyor and locked, so a BIN
 * from another WP is simply not found, and two saves naming the same BIN at
 * once serialise rather than both reading it as free. The match is exact,
 * after the input's trim — the same comparison the certifier wizard uses — so
 * the BIN attached is the BIN typed.
 *
 * Returns null when the customer already occupies the asset: re-attaching
 * would close today's occupancy row and open an identical one beside it,
 * history that records a move nobody made.
 *
 * Moving an asset away from a different occupant is refused until
 * `acknowledgeReassign` says the caller saw whose it is, because it redirects
 * the asset's automated email. A suspended customer being saved is not asked
 * again: the form states what suspension does the moment it is chosen, which
 * is the confirmation `assets.assignCustomer` asks for separately.
 */
async function attachByBin({
	executor,
	waterPurveyorId,
	customer,
	bin,
	acknowledgeReassign,
	actor,
}: {
	executor: JobExecutor;
	waterPurveyorId: string;
	customer: { id: string; status: "active" | "suspended" };
	bin: string;
	acknowledgeReassign: boolean;
	actor: AuditActor;
}): Promise<Attachment | null> {
	const [asset] = await executor
		.select({
			id: bfaAssets.id,
			bin: bfaAssets.bin,
			currentCustomerId: bfaAssets.currentCustomerId,
		})
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
				eq(bfaAssets.bin, bin),
			),
		)
		.limit(1)
		.for("update");

	if (!asset) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: CUSTOMER_BIN_NOT_FOUND_MESSAGE,
		});
	}

	if (asset.currentCustomerId === customer.id) return null;

	if (asset.currentCustomerId && !acknowledgeReassign) {
		// Named only from the caller's own purveyor. A pointer at a foreign
		// customer — a corrupt row — still asks, without saying whose it is.
		const [occupant] = await executor
			.select({ name: customers.name })
			.from(customers)
			.where(
				and(
					eq(customers.id, asset.currentCustomerId),
					eq(customers.waterPurveyorId, waterPurveyorId),
				),
			)
			.limit(1);

		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: customerBinReassignMessage(
				asset.bin,
				occupant?.name ?? "another customer",
			),
		});
	}

	await attachCustomerToAsset({
		executor,
		assetId: asset.id,
		customerId: customer.id,
		customerStatus: customer.status,
		waterPurveyorId,
		actor,
	});

	return { assetId: asset.id, bin: asset.bin, from: asset.currentCustomerId };
}

/**
 * Refuses a save that would leave the customer attached to nothing. Returns
 * null — nothing was attached — so it reads the same as `attachByBin` where
 * the two are chosen between.
 */
async function requireHeldAsset(
	executor: JobExecutor,
	customerId: string,
	waterPurveyorId: string,
): Promise<null> {
	const [held] = await executor
		.select({ id: bfaAssets.id })
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.currentCustomerId, customerId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!held) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: CUSTOMER_BIN_REQUIRED_MESSAGE,
		});
	}

	return null;
}

/**
 * The same `bfa_asset_customer_assigned` line `assets.assignCustomer` writes,
 * so an asset's history reads the same whichever screen attached its occupant.
 */
function logAssignment(
	actor: AuditActor,
	waterPurveyorId: string,
	customer: { id: string; status: "active" | "suspended" },
	attached: Attachment,
) {
	console.log(
		JSON.stringify({
			event: "bfa_asset_customer_assigned",
			...auditActorFields(actor),
			asset_id: attached.assetId,
			wp_id: waterPurveyorId,
			bin: attached.bin,
			from: attached.from,
			to: customer.id,
			to_customer_suspended: customer.status === "suspended",
			timestamp: new Date().toISOString(),
		}),
	);
}

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
