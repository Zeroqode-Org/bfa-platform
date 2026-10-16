import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	customerAssignments,
	customers,
} from "@bfa-platform/db/schema";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import {
	assetColumns,
	assetIdInput,
	assignCustomerInput,
	createAssetInput,
	listAssetsInput,
	updateAssetInput,
} from "../lib/asset-input";
import { effectiveAssetStatus } from "../lib/asset-status-sql";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import { attachCustomerToAsset } from "../lib/customer-assignment";
import { reconcileAssetNoticeChain } from "../scheduler/notice-chain";

/**
 * The columns every asset procedure returns. Declared once so the table, the
 * edit form, the detail view and the mutation responses cannot drift into four
 * shapes of the same row.
 *
 * `assetStatus` is here to be read and nowhere to be written: the scheduler
 * computes it from `annualTestDate`, and neither mutation accepts one.
 */
const assetColumnSelection = {
	id: bfaAssets.id,
	bin: bfaAssets.bin,
	bfaType: bfaAssets.bfaType,
	make: bfaAssets.make,
	model: bfaAssets.model,
	serialNumber: bfaAssets.serialNumber,
	size: bfaAssets.size,
	serviceAddress: bfaAssets.serviceAddress,
	assemblyLocation: bfaAssets.assemblyLocation,
	annualTestDate: bfaAssets.annualTestDate,
	assetStatus: bfaAssets.assetStatus,
	currentCustomerId: bfaAssets.currentCustomerId,
	createdAt: bfaAssets.createdAt,
	updatedAt: bfaAssets.updatedAt,
};

/**
 * The row as every screen wants it: the asset plus who currently occupies it.
 *
 * The customer's *status* travels with the name because of what suspension
 * does — it stops this asset's automated email entirely until a different
 * customer is attached to the BIN. That is a fact about the asset, so the asset
 * list is where it has to be visible; asking the reader to cross-reference the
 * customers screen for it would be asking them to notice a silence.
 */
const assetSelection = {
	...assetColumnSelection,
	currentCustomerName: customers.name,
	currentCustomerStatus: customers.status,
};

/**
 * `assetSelection` with the status worked out from the annual test date as of
 * now, rather than read from the scheduler-written column — see
 * `effectiveAssetStatus`. A function, not a constant, because "today" has to
 * be the request's today.
 */
function assetReadSelection(now = new Date()) {
	return { ...assetSelection, assetStatus: effectiveAssetStatus(now) };
}

/**
 * BFA assets are the WP's own record of the physical valves it is responsible
 * for. A WP registers one directly from this screen — no certifier submission
 * needed (PRD § 7, flow 3) — and the annual test date it is given here is what
 * the reminder workflow schedules against.
 *
 * Every statement below reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the `water_purveyor_id` predicate
 * on each query the authorization boundary in the app, and the policies in
 * `0004_bfa_asset_policies` the same boundary for anything reaching the tables
 * through PostgREST. Neither is a substitute for the other; the RLS suite in
 * `packages/db/src/bfa-assets-rls.test.ts` covers the second.
 */
export const assetsRouter = router({
	/**
	 * One page of the caller's own assets, ordered by BIN.
	 *
	 * The status filter and the search are both optional and independent: a
	 * search for a service address inside the past-due list is a real question,
	 * so they narrow together rather than replacing one another.
	 */
	listAssets: wpProcedure
		.input(listAssetsInput)
		.query(async ({ ctx, input }) => {
			const now = new Date();
			const where = and(
				eq(bfaAssets.waterPurveyorId, ctx.caller.waterPurveyorId),
				// Filtered on the status as of today, not the stored column — the
				// Past due filter once came back empty while assets were years late.
				input.status
					? sql`${effectiveAssetStatus(now)} = ${input.status}::asset_status`
					: undefined,
				searchPredicate(input.search),
			);

			// Counted separately rather than with a window function: the count is over
			// the whole filtered set, the rows are one page of it, and a pager that
			// says "page 3 of 7" needs the first even when the second comes back empty.
			const [totalRow] = await db
				.select({ value: count() })
				.from(bfaAssets)
				.where(where);
			const total = totalRow?.value ?? 0;

			const rows = await db
				.select(assetReadSelection(now))
				.from(bfaAssets)
				.leftJoin(customers, tenantOccupant(ctx.caller.waterPurveyorId))
				.where(where)
				// `id` breaks the tie so two assets sharing a BIN prefix keep a stable
				// order between renders rather than swapping places on refetch. The BIN
				// is unique per purveyor, so in practice the tiebreak never fires — it
				// is here so that a future non-unique sort column cannot make the pager
				// repeat or skip a row.
				.orderBy(asc(bfaAssets.bin), asc(bfaAssets.id))
				.limit(input.pageSize)
				.offset((input.page - 1) * input.pageSize);

			return {
				rows,
				total,
				page: input.page,
				pageSize: input.pageSize,
				pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
			};
		}),

	/**
	 * One asset with its full occupancy history.
	 *
	 * History, not just the current occupant: `bfa_assets.current_customer_id` is
	 * a pointer, and a pointer answers "who gets the email" but not "who had this
	 * valve when that test was signed".
	 */
	getAsset: wpProcedure.input(assetIdInput).query(({ ctx, input }) => {
		return readAssetDetail(ctx.caller.waterPurveyorId, input.id);
	}),

	/**
	 * Registers one asset for the caller's purveyor.
	 *
	 * The tenant comes from `ctx.caller` and nowhere else. There is deliberately
	 * no `waterPurveyorId` on the input: a client cannot ask for another
	 * purveyor's tenant because there is no field in which to ask.
	 *
	 * A first occupant may be named here, and only here. On a brand-new asset
	 * there is no occupancy to close, so attaching one is opening the first
	 * `customer_assignments` row rather than replacing an existing one — the two
	 * writes go in one transaction, so an asset never exists pointing at a
	 * customer with no record of when that started. Changing the occupant of an
	 * asset that already has one stays `assignCustomer`'s, because that case does
	 * have history to preserve.
	 *
	 * The customer is checked against the caller's own purveyor before anything
	 * is written, so a cross-tenant id leaves no asset behind either.
	 *
	 * An asset registered with an annual test date is put on the reminder
	 * schedule in the same transaction. Inside it deliberately: a job scheduled
	 * against an asset whose insert then rolled back would be a reminder about an
	 * assembly that was never registered, addressed to a customer who does not
	 * own it.
	 */
	createAsset: wpProcedure
		.input(createAssetInput)
		.mutation(async ({ ctx, input }) => {
			const waterPurveyorId = ctx.caller.waterPurveyorId;

			const customer = input.currentCustomerId
				? await requireOwnCustomer(waterPurveyorId, input.currentCustomerId)
				: null;

			const row = await db.transaction(async (tx) => {
				const [inserted] = await insertAsset(tx, {
					...assetColumns(input),
					waterPurveyorId,
					currentCustomerId: customer?.id ?? null,
				});

				if (!inserted) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Asset insert returned no row",
					});
				}

				if (customer) {
					await tx.insert(customerAssignments).values({
						bfaAssetId: inserted.id,
						customerId: customer.id,
						startDate: sql`current_date`,
					});
				}

				await reconcileAssetNoticeChain({
					executor: tx,
					assetId: inserted.id,
					waterPurveyorId,
					annualTestDate: inserted.annualTestDate,
					actor: auditActor(ctx),
					trigger: "asset_created",
				});

				return inserted;
			});

			logAssetEvent("bfa_asset_created", {
				actor: auditActor(ctx),
				assetId: row.id,
				waterPurveyorId,
				extra: {
					bin: row.bin,
					bfa_type: row.bfaType,
					annual_test_date: row.annualTestDate,
					current_customer_id: customer?.id ?? null,
				},
			});

			// The occupancy genuinely started, so it gets the same line a later
			// attachment would — an asset's history reads the same whether its first
			// customer arrived with it or a week afterwards.
			if (customer) {
				logAssetEvent("bfa_asset_customer_assigned", {
					actor: auditActor(ctx),
					assetId: row.id,
					waterPurveyorId,
					extra: {
						bin: row.bin,
						from: null,
						to: customer.id,
						to_customer_suspended: customer.status === "suspended",
					},
				});
			}

			return {
				...row,
				currentCustomerName: customer?.name ?? null,
				currentCustomerStatus: customer?.status ?? null,
			};
		}),

	/**
	 * Updates one asset. The whole record is sent, so an omitted optional field
	 * is a field being cleared.
	 *
	 * Both the id *and* the caller's purveyor are in the predicate. Scoping by id
	 * alone would let a guessed or leaked uuid from another tenant be written
	 * through this privileged connection; with the tenant in the `where`, a
	 * cross-WP id matches no row and comes back as a not-found rather than as a
	 * silent success — the read before the write is scoped the same way, so a
	 * foreign row cannot even be observed.
	 */
	updateAsset: wpProcedure
		.input(updateAssetInput)
		.mutation(async ({ ctx, input }) => {
			const tenantScopedRow = and(
				eq(bfaAssets.id, input.id),
				eq(bfaAssets.waterPurveyorId, ctx.caller.waterPurveyorId),
			);

			const [existing] = await db
				.select(assetColumnSelection)
				.from(bfaAssets)
				.where(tenantScopedRow)
				.limit(1);

			if (!existing) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
			}

			const next = assetColumns(input);

			// Opening the edit dialog and pressing save without touching a field is
			// not an update, and writing one anyway would make two records lie.
			// `updated_at` would come to mean "when somebody last pressed save"
			// rather than when the row last changed, and the audit trail would carry
			// a `bfa_asset_updated` line — worse, a BIN-change line naming the same
			// value twice — for a modification that never happened.
			if (isUnchanged(existing, next)) {
				return withCurrentCustomer(ctx.caller.waterPurveyorId, existing);
			}

			// The write and the rescheduling go together or not at all. An asset
			// left carrying a new due date while `scheduled_jobs` still holds the
			// chain computed from the old one is the one failure this feature must
			// not have: a late notice sent against a deadline that moved.
			const row = await db.transaction(async (tx) => {
				const [updated] = await updateAssetRow(tx, next, tenantScopedRow);

				if (!updated) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Asset not found",
					});
				}

				// Only when the date actually moved. Correcting a service address
				// does not touch the schedule, and reconciling anyway would rewrite
				// a job row — and emit a scheduling line — for a schedule nobody
				// changed.
				if (existing.annualTestDate !== updated.annualTestDate) {
					await reconcileAssetNoticeChain({
						executor: tx,
						assetId: updated.id,
						waterPurveyorId: ctx.caller.waterPurveyorId,
						annualTestDate: updated.annualTestDate,
						actor: auditActor(ctx),
						trigger: "annual_test_date_changed",
					});
				}

				return updated;
			});

			logAssetEvent("bfa_asset_updated", {
				actor: auditActor(ctx),
				assetId: row.id,
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: { bin: row.bin },
			});

			// The BIN is the most protected value in the system — every submission,
			// notice and wizard prefill is keyed on it. Changing one is allowed,
			// because a WP may correct any data it owns, but it is never casual, so
			// it gets its own line carrying both values rather than hiding inside
			// the generic update above.
			if (existing.bin !== row.bin) {
				logAssetEvent("bfa_asset_bin_changed", {
					actor: auditActor(ctx),
					assetId: row.id,
					waterPurveyorId: ctx.caller.waterPurveyorId,
					extra: { from: existing.bin, to: row.bin },
				});
			}

			return withCurrentCustomer(ctx.caller.waterPurveyorId, row);
		}),

	/**
	 * Attaches a customer to an asset, preserving whoever was there before.
	 *
	 * The writes themselves — close the open occupancy row, open a new one, move
	 * the live pointer, resume a held chain — are `attachCustomerToAsset`'s, in
	 * one transaction, shared with the customer form's BIN so both sides write
	 * the same history.
	 */
	assignCustomer: wpProcedure
		.input(assignCustomerInput)
		.mutation(async ({ ctx, input }) => {
			const waterPurveyorId = ctx.caller.waterPurveyorId;

			const [asset] = await db
				.select({
					id: bfaAssets.id,
					bin: bfaAssets.bin,
					currentCustomerId: bfaAssets.currentCustomerId,
				})
				.from(bfaAssets)
				.where(
					and(
						eq(bfaAssets.id, input.assetId),
						eq(bfaAssets.waterPurveyorId, waterPurveyorId),
					),
				)
				.limit(1);

			if (!asset) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
			}

			const customer = await requireOwnCustomer(
				waterPurveyorId,
				input.customerId,
			);

			// Re-assigning the customer who is already there is not a reassignment.
			// Writing anyway would close today's occupancy row and open an identical
			// one beside it, turning one continuous tenancy into two — history that
			// records a move nobody made.
			//
			// Checked before the suspension gate below, so re-saving an asset whose
			// occupant was suspended after they were attached is not turned into a
			// confirmation prompt for a change nobody is making.
			if (asset.currentCustomerId === customer.id) {
				return readAssetDetail(waterPurveyorId, asset.id);
			}

			// Attaching a suspended customer stops this asset's automated email
			// entirely until somebody else is attached to the BIN. That consequence
			// is too large to reach by mis-clicking a list, so the server refuses
			// until the request says the caller understood it — the screen's confirm
			// dialog is what sets the flag, and this is the rule it confirms rather
			// than the whole rule.
			if (
				customer.status === "suspended" &&
				!input.acknowledgeSuspendedCustomer
			) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: `${customer.name} is suspended — attaching them pauses this asset's automated email. Confirm to continue.`,
				});
			}

			await db.transaction((tx) =>
				attachCustomerToAsset({
					executor: tx,
					assetId: asset.id,
					customerId: customer.id,
					customerStatus: customer.status,
					waterPurveyorId,
					actor: auditActor(ctx),
				}),
			);

			logAssetEvent("bfa_asset_customer_assigned", {
				actor: auditActor(ctx),
				assetId: asset.id,
				waterPurveyorId,
				extra: {
					bin: asset.bin,
					from: asset.currentCustomerId,
					to: customer.id,
					// Worth carrying: this is the line that explains why the asset's
					// notices went quiet from this date.
					to_customer_suspended: customer.status === "suspended",
				},
			});

			return readAssetDetail(waterPurveyorId, asset.id);
		}),
});

/**
 * BIN or service address, case-insensitively, anywhere in the value.
 *
 * `%` and `_` are escaped rather than passed through: a search for `50%` is
 * somebody looking for those three characters, not asking for a wildcard, and
 * an unescaped `%` would quietly widen their search instead of narrowing it.
 */
function searchPredicate(search: string | undefined) {
	if (!search) return undefined;

	const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;

	return or(
		ilike(bfaAssets.bin, pattern),
		ilike(bfaAssets.serviceAddress, pattern),
	);
}

/**
 * The join condition attaching an asset to its current occupant: the right
 * customer, *and* the caller's own purveyor.
 *
 * The asset is already scoped by the `where` on every query that uses this, but
 * that does not scope the customer. `bfa_assets.current_customer_id` is a
 * foreign key to `customers` and nothing about it says the two share a tenant —
 * `assignCustomer` refuses to point one across, but a row written before that
 * rule, a restore, or corruption is not bound by it. Without this clause such a
 * row would put another purveyor's customer name and status on an asset this
 * caller is entitled to read, through the privileged connection.
 *
 * In the `ON` clause rather than the `where`, which is the difference between
 * failing safe and failing silent. Here the asset comes back with a null
 * occupant — exactly how an unassigned asset already reads, and a state every
 * screen already renders as "Unassigned". In the `where` the asset itself would
 * vanish from the list, hiding the row that needs repairing.
 */
function tenantOccupant(waterPurveyorId: string) {
	return and(
		eq(customers.id, bfaAssets.currentCustomerId),
		eq(customers.waterPurveyorId, waterPurveyorId),
	);
}

/**
 * The same rule for the occupancy history: the assignment's customer, in the
 * caller's own purveyor.
 *
 * A LEFT join where this used to be an INNER one, and the change is the point.
 * `customer_assignments` is keyed by `bfa_asset_id` — the history belongs to
 * the purveyor's own asset, and the fact that an occupancy existed is theirs to
 * see. An INNER join carrying this predicate would delete that fact from the
 * record whenever the customer it named turned out to be foreign, which is a
 * worse answer than showing the occupancy with no name on it.
 *
 * On a correct database the two are identical: every assignment names a
 * customer in the asset's own tenant, so nothing is nulled and nothing is
 * dropped. They differ only on the corrupt row, and there the left join keeps
 * the purveyor's history intact while still withholding the foreign name.
 */
function tenantAssignmentCustomer(waterPurveyorId: string) {
	return and(
		eq(customers.id, customerAssignments.customerId),
		eq(customers.waterPurveyorId, waterPurveyorId),
	);
}

/** One asset with its occupancy history, or a not-found. */
async function readAssetDetail(waterPurveyorId: string, assetId: string) {
	const [asset] = await db
		.select(assetReadSelection())
		.from(bfaAssets)
		.leftJoin(customers, tenantOccupant(waterPurveyorId))
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
	}

	// The asset is already known to belong to the caller, and an assignment
	// belongs to its asset, so scoping the history by `bfa_asset_id` alone is the
	// same boundary reached one step earlier.
	const assignments = await db
		.select({
			id: customerAssignments.id,
			customerId: customerAssignments.customerId,
			customerName: customers.name,
			customerStatus: customers.status,
			startDate: customerAssignments.startDate,
			endDate: customerAssignments.endDate,
		})
		.from(customerAssignments)
		// Left, not inner, and tenant-scoped — see `tenantAssignmentCustomer`.
		// The history row is the purveyor's own record and stays either way; what
		// the predicate withholds is a foreign customer's name.
		.leftJoin(customers, tenantAssignmentCustomer(waterPurveyorId))
		.where(eq(customerAssignments.bfaAssetId, assetId))
		// Newest first, so the open row is at the top where the current occupant
		// is looked for. `created_at` breaks the tie for two assignments that
		// started on the same day — a same-day correction reads in the order it
		// was made rather than arbitrarily.
		.orderBy(
			desc(customerAssignments.startDate),
			desc(customerAssignments.createdAt),
		);

	return { asset, assignments };
}

/**
 * What `assetColumnSelection` returns: the whole row minus the tenant, which
 * the caller already knows and no screen displays.
 */
type AssetRow = Omit<typeof bfaAssets.$inferSelect, "waterPurveyorId">;

/** The asset row plus its current occupant, for the two mutation responses. */
async function withCurrentCustomer(waterPurveyorId: string, asset: AssetRow) {
	if (!asset.currentCustomerId) {
		return { ...asset, currentCustomerName: null, currentCustomerStatus: null };
	}

	const [customer] = await db
		.select({ name: customers.name, status: customers.status })
		.from(customers)
		.where(
			and(
				eq(customers.id, asset.currentCustomerId),
				eq(customers.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	return {
		...asset,
		currentCustomerName: customer?.name ?? null,
		currentCustomerStatus: customer?.status ?? null,
	};
}

/**
 * One customer of the caller's own purveyor, or a not-found.
 *
 * The cross-tenant refusal, in the one place both writers use it. The customer
 * is looked up *inside* the caller's purveyor, so a customer belonging to
 * another WP is not "rejected" after being found — it is never found at all,
 * and the message says nothing about whether that uuid exists elsewhere.
 */
async function requireOwnCustomer(waterPurveyorId: string, customerId: string) {
	const [customer] = await db
		.select({
			id: customers.id,
			name: customers.name,
			status: customers.status,
		})
		.from(customers)
		.where(
			and(
				eq(customers.id, customerId),
				eq(customers.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!customer) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "No customer with that id in this water purveyor",
		});
	}

	return customer;
}

/**
 * The insert, with the one database constraint a person can actually hit turned
 * into something the form can say.
 *
 * `bfa_assets_water_purveyor_id_bin_key` is what makes a BIN unique inside a
 * purveyor — and only inside it, so two WPs numbering their valves the same way
 * never collide. Catching the violation rather than checking first means there
 * is no window between the check and the write for a second clerk to take the
 * BIN.
 *
 * Takes its executor rather than reaching for `db`, so the insert can sit in
 * the same transaction as the occupancy row a new asset's first customer opens.
 */
async function insertAsset(
	executor: Pick<typeof db, "insert">,
	values: typeof bfaAssets.$inferInsert,
) {
	try {
		return await executor
			.insert(bfaAssets)
			.values(values)
			.returning(assetColumnSelection);
	} catch (error) {
		throw duplicateBinError(error, values.bin);
	}
}

/**
 * Takes its executor, like `insertAsset`, so the update can sit in the same
 * transaction as the notice-chain reconciliation a changed due date triggers.
 */
async function updateAssetRow(
	executor: Pick<typeof db, "update">,
	values: ReturnType<typeof assetColumns>,
	where: ReturnType<typeof and>,
) {
	try {
		return await executor
			.update(bfaAssets)
			.set(values)
			.where(where)
			.returning(assetColumnSelection);
	} catch (error) {
		throw duplicateBinError(error, values.bin);
	}
}

/** Postgres' `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

function duplicateBinError(error: unknown, bin: string) {
	if (!isUniqueViolation(error)) return error;

	return new TRPCError({
		code: "CONFLICT",
		message: `BIN ${bin} is already in use by another asset`,
		cause: error,
	});
}

/**
 * Whether a thrown error is Postgres refusing a duplicate row.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` carrying the statement,
 * so the `code` the `pg` driver set is one `cause` down rather than on the
 * error in hand. The chain is walked instead of reaching for `.cause.code`
 * directly, so another wrapping layer — a pool wrapper, a future Drizzle
 * release — does not silently turn a duplicate BIN back into a 500.
 */
function isUniqueViolation(error: unknown) {
	for (
		let current: unknown = error, depth = 0;
		current && depth < 5;
		current = (current as { cause?: unknown }).cause, depth++
	) {
		if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
	}

	return false;
}

/**
 * Whether every writable column already holds the value being written.
 *
 * Driven off `assetColumns`' own keys rather than a hand-written list of
 * comparisons, so a column added to the write set is compared here too instead
 * of quietly becoming a field that a no-op save keeps rewriting.
 *
 * Every value involved is a string, an enum or null — `date` columns come back
 * from the driver as `YYYY-MM-DD` strings — so `===` is the whole comparison.
 */
function isUnchanged(
	existing: Record<string, unknown>,
	next: ReturnType<typeof assetColumns>,
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
function logAssetEvent(
	event: string,
	{
		actor,
		assetId,
		waterPurveyorId,
		extra,
	}: {
		actor: AuditActor;
		assetId: string;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			asset_id: assetId,
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
