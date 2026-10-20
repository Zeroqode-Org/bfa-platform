import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	certifiers,
	customers,
	profiles,
	testSubmissions,
} from "@bfa-platform/db/schema";
import { and, asc, eq, gte, isNotNull, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { router, wpProcedure } from "../index";
import { isPastDue } from "../lib/asset-status-sql";
import {
	monthRangeOf,
	passRate,
	TREND_MONTHS,
	trailingMonthsRange,
} from "../lib/dashboard-calendar";
import { homeListInput, passFailBreakdownInput } from "../lib/dashboard-input";
import { failListEntryCutoff } from "../lib/fail-list-rule";
import { ASSEMBLY_FIELD_KEYS } from "../lib/wizard-input";
import { newestSubmittedTestFirst } from "./submitted-tests";

/**
 * The Water Purveyor home screen: five counts, two short lists, two charts.
 *
 * Everything here is a read, and every read is scoped to
 * `ctx.caller.waterPurveyorId` — taken from the caller's own `profiles` row by
 * `wpProcedure`, never from the request. No input shape in this router names a
 * tenant, so there is nothing for a client to try.
 *
 * Every statement reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the explicit `water_purveyor_id`
 * predicate on each query the authorization boundary in the app, and the
 * policies already on `bfa_assets` (`0004_bfa_asset_policies`) and
 * `test_submissions` (`0008`/`0009`) the same boundary for anything reaching
 * those tables through PostgREST. Neither substitutes for the other. This
 * router adds no table of its own, so it needs no migration and no new policy.
 *
 * **Drafts are not on this screen, anywhere.** Every submission predicate below
 * pins `status = 'submitted'`, the same rule the Submitted Tests router states:
 * a draft is a certifier's working copy of a test nobody has attested to, and
 * counting one would put a number on the purveyor's home screen for work that
 * has not been filed.
 *
 * **Indexes.** The submission queries all lead with
 * `(water_purveyor_id, status)` and then bound or sort on `test_date`, which is
 * exactly `test_submissions_wp_status_test_date_idx` — already on the table for
 * the Submitted Tests list. The asset queries filter on `water_purveyor_id`
 * with an equality on `asset_status`, served by
 * `bfa_assets_water_purveyor_id_idx`; a purveyor's asset count is the size of
 * its own valve inventory, so the narrowed scan is small and a composite index
 * would be a migration bought for nothing. No schema change ships with this
 * feature.
 */
export const dashboardRouter = router({
	/**
	 * The five stat cards, in one request.
	 *
	 * Two statements rather than five: the three submission counts are filtered
	 * aggregates over one scan of the tenant's submitted rows, and the two asset
	 * counts are filtered aggregates over one scan of its assets. Five separate
	 * queries would be five round trips for numbers that have to agree with each
	 * other anyway.
	 *
	 * What each card actually counts:
	 *
	 *   * **Total assets** — every `bfa_assets` row in the tenant, at any status.
	 *   * **Tests this month** — submitted tests whose `test_date` falls in the
	 *     current calendar month. Dated by when the test was *performed* rather
	 *     than when the row was created, because that is the number a compliance
	 *     officer is asked for, and it puts this card on the same basis as the
	 *     trend chart below it. Which month counts as "current" is
	 *     `monthRangeOf(new Date())`, the one zone-dependent step in this
	 *     feature and documented at `dashboard-calendar`.
	 *   * **Past due** — assets whose annual test date has passed, as of today
	 *     in Hawaii (`isPastDue`), not the scheduler-written column.
	 *   * **Submitted reports** — every submitted row in the tenant.
	 *   * **No-BIN submissions** — submitted rows with no BIN: linked to a
	 *     no-BIN asset the wizard registered at submit, or (filed before that)
	 *     not linked at all. See {@link noBinSubmission}.
	 *
	 * `submittedReports` is the build plan's "submissions awaiting review"
	 * (§ 6.4.1), renamed to what the schema can actually support. There is no
	 * review lifecycle on `test_submissions` — `status` is only
	 * `draft | submitted` — and the confirmed product decision was to count
	 * submitted rows rather than invent one. So this is an *incoming* counter,
	 * not a queue that drains: nothing marks a test reviewed, and the number
	 * only goes up. The card is labelled "Submitted reports" for that reason;
	 * "Awaiting review" would promise a queue the product does not have.
	 *
	 * Two rejected readings, recorded so they are not re-proposed.
	 * `bfa_asset_id is null` is already the No-BIN card and would have made two
	 * of five cards permanently identical. `edited_by_wp_profile_id is null`
	 * would have read a WP *correction* as a review sign-off, which is not what
	 * that column means.
	 */
	dashboardMetrics: wpProcedure.query(async ({ ctx }) => {
		const waterPurveyorId = ctx.caller.waterPurveyorId;
		const thisMonth = monthRangeOf(new Date());

		const [assetTotals, submissionTotals] = await Promise.all([
			db
				.select({
					totalAssets: sql<number>`count(*)::int`,
					// From the annual test date as of today, not the scheduler-written
					// column — see `isPastDue`. The card read 0 while assets were
					// years late on a deployment whose tick rarely ran.
					pastDue: countWhere(isPastDue()),
				})
				.from(bfaAssets)
				.where(eq(bfaAssets.waterPurveyorId, waterPurveyorId)),

			db
				.select({
					submittedReports: sql<number>`count(*)::int`,
					// Between the month's first and last calendar day, inclusive.
					// `test_date` is a Postgres `date`, so this is a calendar
					// comparison with no zone in it and no time component for an
					// inclusive upper bound to clip — the 31st means the 31st. A
					// submitted row carrying no `test_date` falls in no month at all,
					// which is correct: it is a record with a gap in it, not a test
					// performed today.
					testsThisMonth: countWhere(
						sql`${testSubmissions.testDate} between ${thisMonth.start} and ${thisMonth.end}`,
					),
					noBinSubmissions: countWhere(noBinSubmission(waterPurveyorId)),
				})
				.from(testSubmissions)
				.where(submittedRowsOf(waterPurveyorId)),
		]);

		return {
			totalAssets: assetTotals[0]?.totalAssets ?? 0,
			testsThisMonth: submissionTotals[0]?.testsThisMonth ?? 0,
			pastDue: assetTotals[0]?.pastDue ?? 0,
			submittedReports: submissionTotals[0]?.submittedReports ?? 0,
			noBinSubmissions: submissionTotals[0]?.noBinSubmissions ?? 0,
			/** The window "tests this month" was measured over, so the card can say so. */
			month: thisMonth.month,
		};
	}),

	/**
	 * Monthly pass rate over the trailing twelve calendar months, oldest first.
	 *
	 * Always twelve entries, whether or not a month has a row in it. The x-axis
	 * is a property of the calendar rather than of the data: a trend that
	 * dropped its quiet months would draw a straight line across a gap and call
	 * it continuity, and the twelve keys arriving in chronological order is what
	 * lets the chart render without sorting or gap-filling anything itself.
	 *
	 * Grouped in Postgres, re-attached to the calendar in TypeScript. The
	 * alternative — a `generate_series` left join — would put the month
	 * arithmetic somewhere no test can reach without a database, and the
	 * arithmetic is the part with the edge cases in it.
	 *
	 * Only rows with a non-null `test_result` are counted. A submitted test
	 * missing its result is not a failure; it is a record that never recorded
	 * one, and letting it into the denominator would quietly depress the rate of
	 * every month it appeared in. A month holding nothing but such rows comes
	 * back the same as a month holding nothing at all, which for this chart is
	 * what it is.
	 *
	 * `passRate` is `null`, never `0`, for a month nothing was tested in. A
	 * month in which nobody tested anything is not a month in which every test
	 * failed: the chart breaks its line across the first and plots a point on
	 * the second.
	 */
	complianceTrend: wpProcedure.query(async ({ ctx }) => {
		const waterPurveyorId = ctx.caller.waterPurveyorId;
		const window = trailingMonthsRange(new Date());

		// `to_char` on the `date` column directly rather than through
		// `date_trunc`: the column has no time component to truncate, and the
		// `YYYY-MM` text it produces is both the group key and the key the
		// response carries, so there is no second spelling to keep in step.
		const monthKey = sql<string>`to_char(${testSubmissions.testDate}, 'YYYY-MM')`;

		const grouped = await db
			.select({
				month: monthKey,
				passCount: countWhere(sql`${testSubmissions.testResult} = 'pass'`),
				failCount: countWhere(sql`${testSubmissions.testResult} = 'fail'`),
			})
			.from(testSubmissions)
			.where(
				and(
					submittedRowsOf(waterPurveyorId),
					isNotNull(testSubmissions.testResult),
					gte(testSubmissions.testDate, window.start),
					lte(testSubmissions.testDate, window.end),
				),
			)
			.groupBy(monthKey);

		const byMonth = new Map(grouped.map((row) => [row.month, row]));

		return {
			months: window.months.map(({ month }) => {
				const counted = byMonth.get(month);
				const passCount = counted?.passCount ?? 0;
				const failCount = counted?.failCount ?? 0;

				return {
					month,
					passCount,
					failCount,
					testedCount: passCount + failCount,
					passRate: passRate(passCount, failCount),
				};
			}),
			monthCount: TREND_MONTHS,
		};
	}),

	/**
	 * Pass and fail counts for one chosen window.
	 *
	 * **The contract is `pass`, `fail` and `total`, and nothing else.** That is
	 * what the build plan asks for (§ 6.4.3, "counts by result over a selectable
	 * range") and what the chart draws. Both bounds are inclusive, on calendar
	 * dates: `test_date` is a Postgres `date`, so the 1st to the 30th is exactly
	 * those thirty days with no zone in the comparison.
	 *
	 * The range is echoed back so the chart can caption itself with the window
	 * these counts were actually measured over rather than with whatever is
	 * currently in the two date inputs. Those disagree for as long as a request
	 * is in flight, and a chart labelled with the pending range would tell a
	 * small lie every time somebody changed it.
	 *
	 * A submitted test with a null `test_result` lands in neither count. It is
	 * not a failure — it is a record that never recorded one — so folding it
	 * into `fail` would accuse a certifier of something that never happened, and
	 * dropping it entirely would make `pass + fail` look like the number of
	 * tests filed in the window when it is not.
	 *
	 * So it is reported, and reported *outside* the breakdown: `supplemental`
	 * is a deliberate second level rather than a fourth sibling of `pass` and
	 * `fail`. A caller has to name it to read it, which is what keeps it from
	 * drifting into the chart as a third bar or into `total` as a third
	 * addend — and what keeps this procedure's primary shape strictly pass and
	 * fail. Nothing in the contract depends on it; a consumer that ignores it
	 * gets a correct breakdown.
	 */
	passFailBreakdown: wpProcedure
		.input(passFailBreakdownInput)
		.query(async ({ ctx, input }) => {
			const [counts] = await db
				.select({
					pass: countWhere(sql`${testSubmissions.testResult} = 'pass'`),
					fail: countWhere(sql`${testSubmissions.testResult} = 'fail'`),
					unrecorded: countWhere(sql`${testSubmissions.testResult} is null`),
				})
				.from(testSubmissions)
				.where(
					and(
						submittedRowsOf(ctx.caller.waterPurveyorId),
						gte(testSubmissions.testDate, input.from),
						lte(testSubmissions.testDate, input.to),
					),
				);

			const pass = counts?.pass ?? 0;
			const fail = counts?.fail ?? 0;

			return {
				from: input.from,
				to: input.to,
				pass,
				fail,
				/** The denominator of the rate: results, not rows. */
				total: pass + fail,
				/**
				 * Counts that are deliberately **not** part of the breakdown.
				 *
				 * Optional to the contract above and nested so that it reads that way
				 * at the call site. A screen may show `unrecorded` — this one does,
				 * as a note beneath the chart rather than inside it — but it is never
				 * a bar, never in `total`, and never needed to render the pass/fail
				 * answer correctly.
				 */
				supplemental: {
					/** Submitted inside the window, with no result recorded on the row. */
					unrecorded: counts?.unrecorded ?? 0,
				},
			};
		}),

	/**
	 * The head of the Submitted Tests list — the newest tests filed against this
	 * purveyor.
	 *
	 * Literally the head: it shares `newestSubmittedTestFirst` with
	 * `listSubmittedTests` rather than restating the ordering, so the first five
	 * rows here are the first five rows there. Two orderings meant to match but
	 * written twice would eventually stop matching, and this list's whole
	 * promise is that clicking a row lands on the same record.
	 *
	 * Cross-certifier, like the list it previews: this is the purveyor's inbox,
	 * not one certifier's archive.
	 *
	 * `bin` and `submittedBinText` both travel, for the reason
	 * `submittedTestsRouter` gives: the first is the asset's, present only once
	 * a submission has been resolved to one, and the second is what the
	 * certifier typed when it had not. `binLabel` on the client picks between
	 * them and says which it got.
	 */
	incomingReports: wpProcedure.input(homeListInput).query(({ ctx, input }) => {
		return (
			db
				.select({
					id: testSubmissions.id,
					bfaType: testSubmissions.bfaType,
					testDate: testSubmissions.testDate,
					testResult: testSubmissions.testResult,
					submittedBinText: testSubmissions.submittedBinText,
					bin: bfaAssets.bin,
					// From `profiles`, not `certifiers`: a certifier's name is their
					// account's name and lives in one place — the same join
					// `listSubmittedTests` and `listWpCertifiers` both make.
					certifierName: profiles.fullName,
				})
				.from(testSubmissions)
				// Left, not inner: an unresolved submission is precisely the row this
				// list exists to surface, and an inner join would hide the ones that
				// need work.
				//
				// The tenant predicate rides on the *join*, and both halves of that
				// matter. `test_submissions.water_purveyor_id` scopes the
				// submission; the foreign key on `bfa_asset_id` only proves the
				// asset exists, not that it belongs to the same purveyor. Without
				// this clause a row whose link crossed tenants — corruption, or a
				// write that predated `0009_test_submission_asset_tenancy` — would
				// hand back another purveyor's BIN through a submission this caller
				// is entitled to read.
				//
				// In the `ON` clause it fails safe: the submission still appears,
				// with its asset columns null, which is exactly how an unlinked row
				// already reads. In the `where` it would drop the row from the list
				// instead, hiding the one submission somebody needs to go and fix.
				.leftJoin(
					bfaAssets,
					and(
						eq(bfaAssets.id, testSubmissions.bfaAssetId),
						eq(bfaAssets.waterPurveyorId, ctx.caller.waterPurveyorId),
					),
				)
				.innerJoin(certifiers, eq(certifiers.id, testSubmissions.certifierId))
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(submittedRowsOf(ctx.caller.waterPurveyorId))
				.orderBy(...newestSubmittedTestFirst)
				.limit(input.limit)
		);
	}),

	/**
	 * The No-BIN table: submitted tests the purveyor still has to number, newest
	 * first — the same order, and so the same head, as the incoming list.
	 *
	 * Each row is a work item. One linked to a no-BIN asset is opened on that
	 * asset, where the WP assigns the BIN and attaches the customer, or the test
	 * is linked to an assembly already registered (which deletes the empty
	 * asset). One filed before no-BIN assets existed has no asset at all and is
	 * opened on the test, where the BIN is typed as before.
	 *
	 * The service address is the asset's when there is one, else the test's own
	 * answer — the WP needs to know where the valve is either way.
	 */
	noBinReports: wpProcedure.input(homeListInput).query(({ ctx, input }) => {
		const waterPurveyorId = ctx.caller.waterPurveyorId;

		return (
			db
				.select({
					id: testSubmissions.id,
					bfaAssetId: bfaAssets.id,
					bfaType: testSubmissions.bfaType,
					testDate: testSubmissions.testDate,
					testResult: testSubmissions.testResult,
					serviceAddress: sql<
						string | null
					>`coalesce(${bfaAssets.serviceAddress}, ${testSubmissions.wizardData} ->> ${ASSEMBLY_FIELD_KEYS.serviceAddress})`,
					hasCustomer: sql<boolean>`${bfaAssets.currentCustomerId} is not null`,
					certifierName: profiles.fullName,
				})
				.from(testSubmissions)
				// Tenant-scoped on the join, as in `incomingReports`.
				.leftJoin(
					bfaAssets,
					and(
						eq(bfaAssets.id, testSubmissions.bfaAssetId),
						eq(bfaAssets.waterPurveyorId, waterPurveyorId),
					),
				)
				.innerJoin(certifiers, eq(certifiers.id, testSubmissions.certifierId))
				.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
				.where(
					and(
						submittedRowsOf(waterPurveyorId),
						noBinSubmission(waterPurveyorId),
					),
				)
				.orderBy(...newestSubmittedTestFirst)
				.limit(input.limit)
		);
	}),

	/**
	 * The assets whose annual test date has passed (`isPastDue`), oldest test
	 * date first.
	 *
	 * `asset_status` is read here and written nowhere: the scheduler computes it
	 * from `annual_test_date`, and no procedure in the app accepts one. This
	 * list is a view of that computation, not a second opinion about it.
	 *
	 * Ordered by the date that made them delinquent rather than by BIN, because
	 * the question this list answers is "who is worst" rather than "who is
	 * where". An asset with no annual test date is never on this list — past
	 * due is read from the date — so `nulls last` is only a guard. `bin` breaks
	 * the tie, so two assets due the same day hold a stable order between
	 * renders.
	 *
	 * The occupant's name comes along because this list is a work queue — the
	 * next action on one of these rows is contacting somebody — and the join is
	 * left because an asset between occupants is still past due.
	 */
	delinquentAssets: wpProcedure.input(homeListInput).query(({ ctx, input }) => {
		return (
			db
				.select({
					id: bfaAssets.id,
					bin: bfaAssets.bin,
					bfaType: bfaAssets.bfaType,
					serviceAddress: bfaAssets.serviceAddress,
					annualTestDate: bfaAssets.annualTestDate,
					currentCustomerName: customers.name,
				})
				.from(bfaAssets)
				// Tenant-scoped on the join, the same rule and the same reasoning as
				// the asset join in `incomingReports` above. `bfa_assets` is already
				// narrowed to the caller's purveyor by the `where`, but
				// `current_customer_id` is a foreign key to `customers` and nothing in
				// it says the customer shares the asset's tenant — so without this
				// clause a mispointed asset would put another purveyor's customer name
				// on a row this caller is entitled to read.
				//
				// In the `ON` clause so it fails safe: the past-due asset stays in the
				// queue with a null occupant, which is how an asset between occupants
				// already reads. In the `where` the asset would drop out of the
				// delinquent list altogether — the worst place to hide a row, since
				// this list is the work queue for exactly these.
				.leftJoin(
					customers,
					and(
						eq(customers.id, bfaAssets.currentCustomerId),
						eq(customers.waterPurveyorId, ctx.caller.waterPurveyorId),
					),
				)
				.where(
					and(
						eq(bfaAssets.waterPurveyorId, ctx.caller.waterPurveyorId),
						isPastDue(),
					),
				)
				.orderBy(
					sql`${bfaAssets.annualTestDate} asc nulls last`,
					asc(bfaAssets.bin),
				)
				.limit(input.limit)
		);
	}),

	/**
	 * The fail list — assets with a failure 30 days unresolved. The rule, the
	 * definitions and the tenant boundary are documented on
	 * {@link listFailingAssets}, which this calls with the real clock.
	 */
	failList: wpProcedure.query(({ ctx }) => {
		return listFailingAssets({
			waterPurveyorId: ctx.caller.waterPurveyorId,
			now: new Date(),
		});
	}),
});

/**
 * A filtered aggregate, cast to a JavaScript number.
 *
 * `count()` is a bigint, which `node-postgres` hands back as a string rather
 * than risk a silent precision loss — so a card that skipped the cast would
 * render `"0"`, and, worse, `passRate` would be computed from string
 * arithmetic. The parentheses are load-bearing: `::int` has to apply to the
 * whole `count(*) filter (…)` expression, not to its argument.
 *
 * `filter (where …)` rather than `sum(case when … then 1 else 0 end)` because
 * it is the same single scan either way and this one says what it means.
 */
function countWhere(predicate: ReturnType<typeof sql>) {
	return sql<number>`(count(*) filter (where ${predicate}))::int`;
}

/**
 * A submitted test with no BIN: not linked to an asset (filed before the
 * wizard registered no-BIN assets), or linked to one whose BIN is still null.
 * One `not exists` covers both, and it is the card's and the table's single
 * definition, so the count and the rows cannot disagree.
 */
function noBinSubmission(waterPurveyorId: string) {
	return sql`not exists (
		select 1 from ${bfaAssets}
		where ${bfaAssets.id} = ${testSubmissions.bfaAssetId}
			and ${bfaAssets.waterPurveyorId} = ${waterPurveyorId}
			and ${bfaAssets.bin} is not null
	)`;
}

/**
 * The tenant-and-status predicate every submission query in this router shares.
 *
 * One function rather than two clauses repeated four times, because these two
 * conditions are one rule — "rows this purveyor is entitled to count" — and a
 * query that picked up only half of it would be a cross-tenant leak or a draft
 * leak depending on which half was dropped. The same shape, and the same
 * reasoning, as `submittedRowsOf` in `submitted-tests.ts`.
 */
function submittedRowsOf(waterPurveyorId: string) {
	return and(
		eq(testSubmissions.waterPurveyorId, waterPurveyorId),
		eq(testSubmissions.status, "submitted"),
	);
}

/**
 * The fail list: every asset with a failure episode that has gone **30 days
 * without a later submitted passing test**, with the calendar day that
 * episode began.
 *
 * The product rule (PRD § 6.8, flow 5): the failure *email* goes out
 * immediately on a submitted fail — that is the failure notice's job, not
 * this list's — and the asset reaches this list only once 30 days have
 * elapsed with no passing re-test. A later submitted pass removes it at once,
 * whether it had already appeared or was still inside its 30 days. Nothing
 * here records whether a repair happened; only whether a pass was filed.
 *
 * **Membership is computed from test history on every read.** There is no
 * stored flag, no membership table, and no scheduled job that "adds" an asset
 * on day 30: an episode crosses the boundary purely because `now` moved, so
 * the read is the only place the rule needs to live. The pre-declared
 * `fail_list_check` job type stays unused.
 *
 * The definitions, stated once because two features depend on them agreeing
 * (the failure-notice handler makes the same later-pass comparison at send
 * time):
 *
 * - Only rows with `status = 'submitted'` and a non-null `test_result`
 *   participate, and only rows linked to an asset. Drafts, result-less
 *   records and unlinked no-BIN submissions decide nothing — an unlinked fail
 *   counts from its own submission time once a WP links it.
 * - Event order is `(created_at, id)` — when the submission *happened*,
 *   with the id as a deterministic tie-breaker — never `test_date`, which
 *   is nullable and certifier-typed. "A later passing test" means submitted
 *   later, not dated later. A re-test is always a new submitted record.
 * - A **failure episode** starts at the first submitted fail after the
 *   asset's last submitted pass. Later fails inside the episode do not reset
 *   its start or its 30-day clock — each still triggers its own failure
 *   email, but the list shows one row per asset, aged from the beginning.
 * - **The boundary:** the episode is listed when its first failure's
 *   `created_at` is at or before `now − 30 × 24 hours`
 *   (`failListEntryCutoff`). At exactly 30 days elapsed it is listed; a
 *   millisecond earlier it is not.
 * - `failingSince` is the starting submission's UTC calendar day, the same
 *   instant-to-day convention as the page's `today`.
 *
 * The `min(...)` below is exactly the episode start: the earliest submitted
 * fail with no later submitted pass. If the latest resulted test is a pass,
 * every fail has a later pass and the asset has no group at all; the
 * `having` then applies the 30-day rule to the groups that remain.
 *
 * `now` is a parameter rather than read inside so the boundary is testable to
 * the millisecond; `dashboard.failList` passes the real clock. The cutoff is
 * computed in TypeScript and bound as a `timestamptz`, so Postgres applies no
 * session-zone calendar arithmetic of its own.
 *
 * One row per asset by construction (`group by`), the whole list in one
 * response: this is a work queue bounded by the purveyor's own assemblies
 * with a long-unresolved failure, and its default order — oldest failure
 * first, BIN then id breaking ties — is the server's, so the screen and any
 * export start from the same answer. Re-sorting by another column is
 * presentation and happens on the client, over the same rows.
 *
 * Tenant boundary: the fail rows, the asset join and the customer join are
 * each pinned to the purveyor. The joins are pinned *as well as* keyed
 * because a foreign key proves existence, not tenancy — a submission whose
 * link crossed tenants simply produces no row here, and a mispointed
 * `current_customer_id` shows as no customer rather than as another
 * purveyor's name. `waterPurveyorId` must come from the caller's own profile;
 * the procedure takes no input that could name one.
 */
export function listFailingAssets({
	waterPurveyorId,
	now,
}: {
	waterPurveyorId: string;
	now: Date;
}) {
	const laterPass = alias(testSubmissions, "later_pass");
	const cutoff = failListEntryCutoff(now);

	const failing = db.$with("failing").as(
		db
			.select({
				assetId: testSubmissions.bfaAssetId,
				failingSince:
					sql<string>`to_char(min(${testSubmissions.createdAt}) at time zone 'utc', 'YYYY-MM-DD')`.as(
						"failing_since",
					),
			})
			.from(testSubmissions)
			.where(
				and(
					eq(testSubmissions.waterPurveyorId, waterPurveyorId),
					eq(testSubmissions.status, "submitted"),
					eq(testSubmissions.testResult, "fail"),
					isNotNull(testSubmissions.bfaAssetId),
					notExists(
						db
							.select({ one: sql`1` })
							.from(laterPass)
							.where(
								and(
									eq(laterPass.bfaAssetId, testSubmissions.bfaAssetId),
									eq(laterPass.waterPurveyorId, waterPurveyorId),
									eq(laterPass.status, "submitted"),
									eq(laterPass.testResult, "pass"),
									// Row comparison, so two submissions in the same
									// microsecond still have a total order.
									sql`(${laterPass.createdAt}, ${laterPass.id}) > (${testSubmissions.createdAt}, ${testSubmissions.id})`,
								),
							),
					),
				),
			)
			.groupBy(testSubmissions.bfaAssetId)
			// The 30-day rule, on the episode's first failure — not on the latest
			// one, so a second fail inside the episode cannot restart the clock.
			.having(
				sql`min(${testSubmissions.createdAt}) <= ${cutoff.toISOString()}::timestamptz`,
			),
	);

	return (
		db
			.with(failing)
			.select({
				id: bfaAssets.id,
				bin: bfaAssets.bin,
				bfaType: bfaAssets.bfaType,
				serviceAddress: bfaAssets.serviceAddress,
				currentCustomerName: customers.name,
				failingSince: failing.failingSince,
			})
			.from(failing)
			// Inner, unlike the two home lists' left joins: a failing submission
			// whose asset is missing or belongs to another purveyor represents no
			// assembly this caller may see, so there is no safe row to render.
			// A no-BIN asset is left out too: its result waits for the BIN, the
			// same as its failure notice does (`applySubmittedTestResult`).
			.innerJoin(
				bfaAssets,
				and(
					eq(bfaAssets.id, failing.assetId),
					eq(bfaAssets.waterPurveyorId, waterPurveyorId),
					isNotNull(bfaAssets.bin),
				),
			)
			.leftJoin(
				customers,
				and(
					eq(customers.id, bfaAssets.currentCustomerId),
					eq(customers.waterPurveyorId, waterPurveyorId),
				),
			)
			.orderBy(asc(failing.failingSince), asc(bfaAssets.bin), asc(bfaAssets.id))
	);
}
