import { randomUUID } from "node:crypto";
import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import type { inferProcedureInput, inferProcedureOutput } from "@trpc/server";
import pg from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { monthRangeOf, trailingMonthsRange } from "../lib/dashboard-calendar";
import type { AppRouter } from "./index";

/**
 * The dashboard procedures against real Postgres: who may call them, whose rows
 * they count, and whether the numbers reconcile with the table underneath.
 *
 * Two purveyors are seeded as deliberate mirror images — the same certifier,
 * the same BIN, the same test dates, the same results, in both tenants. A leak
 * between them has to look like a leak rather than like a plausible row, and
 * counting metrics make that harder than listing ones do: a list that returned
 * a foreign row shows a foreign id, but a *count* that included one just looks
 * like a bigger number. So every count here is asserted against B's own rows as
 * well as against A's, and the reconciliation tests below re-derive the same
 * figures straight from SQL.
 *
 * The clock is frozen for the whole suite. "This month" and "the trailing
 * twelve months" are the two things this feature is most likely to get wrong,
 * and a suite that read the real date would pass in September and fail in
 * January — or, worse, drift its own fixtures out of the window it is
 * asserting about.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary with their own suites in
 * `packages/db`.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

/**
 * The procedures' own input and output types, taken one at a time rather than
 * through `inferRouterInputs`/`inferRouterOutputs` — those describe what travels
 * over HTTP, and a `createCaller` caller returns what the procedure returned.
 */
type Dashboard = AppRouter["dashboard"];
type Inputs = {
	[Procedure in keyof Dashboard]: inferProcedureInput<Dashboard[Procedure]>;
};
type Outputs = {
	[Procedure in keyof Dashboard]: inferProcedureOutput<Dashboard[Procedure]>;
};

/**
 * The instant every test in this file believes it is.
 *
 * Mid-month on purpose: the 11th leaves room on both sides, so a fixture dated
 * the 1st and one dated the 30th are both "this month" and neither is
 * accidentally today. Trailing twelve months from here is 2025-10-01 through
 * 2026-09-30.
 */
const NOW = new Date("2026-09-11T12:00:00Z");
const THIS_MONTH = monthRangeOf(NOW);
const TREND_WINDOW = trailingMonthsRange(NOW);

const wpA = randomUUID();
const wpB = randomUUID();
const ids = {
	adminA: randomUUID(),
	employeeA: randomUUID(),
	adminB: randomUUID(),
	certifierProfile: randomUUID(),
	superAdmin: randomUUID(),
	orphanedWpAdmin: randomUUID(),
};
const certifier = randomUUID();

/** Assets, one mirrored pair per status the dashboard cares about. */
const pastDueA = randomUUID();
const pastDueA2 = randomUUID();
const activeA = randomUUID();
const pastDueB = randomUUID();
const activeB = randomUUID();

let pool: pg.Pool;

let callerFor: (profileId: string) => {
	dashboard: {
		dashboardMetrics: () => Promise<Outputs["dashboardMetrics"]>;
		complianceTrend: () => Promise<Outputs["complianceTrend"]>;
		passFailBreakdown: (
			input: Inputs["passFailBreakdown"],
		) => Promise<Outputs["passFailBreakdown"]>;
		incomingReports: (
			input?: Inputs["incomingReports"],
		) => Promise<Outputs["incomingReports"]>;
		delinquentAssets: (
			input?: Inputs["delinquentAssets"],
		) => Promise<Outputs["delinquentAssets"]>;
	};
	/**
	 * The Submitted Tests list, reached from here for one assertion only: that
	 * the dashboard's incoming rows really are the head of it. The two share
	 * `newestSubmittedTestFirst`, and this is what proves the sharing works
	 * rather than merely looks like it does.
	 */
	submittedTests: {
		listSubmittedTests: (
			input?: inferProcedureInput<
				AppRouter["submittedTests"]["listSubmittedTests"]
			>,
		) => Promise<
			inferProcedureOutput<AppRouter["submittedTests"]["listSubmittedTests"]>
		>;
	};
};

/**
 * Inserts one submission directly.
 *
 * Through SQL rather than a procedure because there is no procedure that makes
 * one: a submission is the certifier wizard's to create (§ 6.5), and neither
 * this router nor the submitted-tests router has an insert. So the fixtures
 * arrive the way the wizard's rows will.
 */
async function seedSubmission({
	waterPurveyorId,
	status = "submitted",
	bfaAssetId = null,
	testDate = "2026-09-02",
	testResult = "pass",
	submittedBinText = null,
	id = randomUUID(),
}: {
	waterPurveyorId: string;
	status?: string;
	bfaAssetId?: string | null;
	testDate?: string | null;
	testResult?: string | null;
	submittedBinText?: string | null;
	id?: string;
}) {
	await pool.query(
		`insert into test_submissions
		   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
		    wizard_data, submitted_bin_text, test_date, test_result)
		 values ($1, $2, $3, $4, $5::submission_status, 'RP', $6::jsonb, $7, $8, $9::test_result)`,
		[
			id,
			bfaAssetId,
			certifier,
			waterPurveyorId,
			status,
			JSON.stringify({ fixtureKey: "dashboard-fixture" }),
			submittedBinText,
			testDate,
			testResult,
		],
	);

	return id;
}

/**
 * The mirrored submission fixture, seeded identically into both purveyors.
 *
 * Every row has a twin in the other tenant with the same date, the same result
 * and the same shape, so any count that leaks across shows up as exactly double
 * rather than as a number somebody has to squint at. The dates are chosen
 * against the frozen clock:
 *
 *   * two this month (one pass, one fail);
 *   * one earlier in the trend window;
 *   * one in the oldest month of the window, to pin the lower bound;
 *   * one the day *before* the window opens, which must never be counted;
 *   * one submitted row with no result at all;
 *   * one no-BIN row;
 *   * one draft, which nothing on this screen may ever see.
 */
async function seedMirroredSubmissions(waterPurveyorId: string) {
	await seedSubmission({ waterPurveyorId, testDate: "2026-09-01" });
	await seedSubmission({
		waterPurveyorId,
		testDate: "2026-09-30",
		testResult: "fail",
	});
	await seedSubmission({ waterPurveyorId, testDate: "2026-04-15" });
	// The oldest month in the window, on its first day: the inclusive lower
	// bound, which an exclusive `>` would drop.
	await seedSubmission({ waterPurveyorId, testDate: "2025-10-01" });
	// One day before the window opens. Counted by nothing here.
	await seedSubmission({ waterPurveyorId, testDate: "2025-09-30" });
	// Submitted, but nobody recorded a result. In no rate, in no bar.
	await seedSubmission({
		waterPurveyorId,
		testDate: "2026-06-10",
		testResult: null,
	});
	// The no-BIN flow: no asset, only what the certifier typed.
	await seedSubmission({
		waterPurveyorId,
		testDate: "2026-08-05",
		submittedBinText: "TYPED-BIN-404",
		testResult: "fail",
	});
	// A draft dated this month. If any number moves because of this row, drafts
	// have leaked onto a purveyor's home screen.
	await seedSubmission({
		waterPurveyorId,
		status: "draft",
		testDate: "2026-09-03",
		testResult: "pass",
	});
}

describeDb("dashboard procedures", () => {
	beforeAll(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const { t } = await import("../index");
		const { appRouter } = await import("./index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				// `protectedProcedure` re-resolves the profile from the database, so
				// only the auth user id matters here.
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as ReturnType<typeof callerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Dashboard Fixture Water Works', 'DASH-A', 'active'),
			        ($2, 'Dashboard Fixture Water Works', 'DASH-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string][] = [
			[ids.adminA, wpA, "wp_admin"],
			[ids.employeeA, wpA, "wp_employee"],
			[ids.adminB, wpB, "wp_admin"],
			[ids.certifierProfile, null, "certifier"],
			[ids.superAdmin, null, "super_admin"],
			// A WP role with no purveyor on the row — the broken state
			// `wpProcedure` refuses rather than running an unscoped query for.
			[ids.orphanedWpAdmin, null, "wp_admin"],
		];

		for (const [id, wp, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'Dashboard Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}

		// One certifier files into both purveyors, which is the normal case on
		// this platform and the reason a submission's tenancy cannot be read
		// through the certifier who filed it.
		await pool.query(
			`insert into certifiers (id, profile_id, company, status)
			 values ($1, $2, 'Fixture Backflow Testing', 'active')`,
			[certifier, ids.certifierProfile],
		);

		// Same BINs and the same addresses in both tenants: a row showing up in
		// the wrong list is unmistakably the wrong row. A's two past-due assets
		// are dated a year apart, which is what the "worst first" ordering is
		// asserted against.
		await pool.query(
			`insert into bfa_assets
			   (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date, asset_status)
			 values ($1, $2, 'DASH-OVERDUE-1', 'RP', '1 Shared Way', '2025-03-01', 'past_due'),
			        ($3, $4, 'DASH-OVERDUE-2', 'DC', '2 Shared Way', '2026-02-01', 'past_due'),
			        ($5, $6, 'DASH-CURRENT',   'RP', '3 Shared Way', '2027-01-15', 'active'),
			        ($7, $8, 'DASH-OVERDUE-1', 'RP', '1 Shared Way', '2025-03-01', 'past_due'),
			        ($9, $10,'DASH-CURRENT',   'RP', '3 Shared Way', '2027-01-15', 'active')`,
			[
				pastDueA,
				wpA,
				pastDueA2,
				wpA,
				activeA,
				wpA,
				pastDueB,
				wpB,
				activeB,
				wpB,
			],
		);

		await seedMirroredSubmissions(wpA);
		await seedMirroredSubmissions(wpB);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// `restoreAllMocks` does not undo fake timers, but a test that installs
		// its own clock must not leak it into the next one.
		vi.setSystemTime(NOW);
	});

	afterAll(async () => {
		vi.useRealTimers();

		if (!pool) return;

		await pool.query(
			"delete from test_submissions where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
		await pool.query(
			"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
		await pool.query("delete from certifiers where id = $1", [certifier]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB],
		]);
		await pool.end();
	});

	// Every procedure, not a representative one. A dashboard is five separate
	// entry points into the same tenant's data, and a role check that was only
	// ever asserted on the first of them is a check the other four could be
	// missing.
	describe("who may call them at all", () => {
		const range = { from: "2026-01-01", to: "2026-12-31" };

		function everyProcedure(profileId: string) {
			const caller = callerFor(profileId).dashboard;

			return [
				() => caller.dashboardMetrics(),
				() => caller.complianceTrend(),
				() => caller.passFailBreakdown(range),
				() => caller.incomingReports({}),
				() => caller.delinquentAssets({}),
			];
		}

		it("refuses a certifier on every procedure", async () => {
			for (const call of everyProcedure(ids.certifierProfile)) {
				await expect(call()).rejects.toThrow(/water purveyor only/i);
			}
		});

		it("refuses a Super-Admin, rather than summing every tenant", async () => {
			for (const call of everyProcedure(ids.superAdmin)) {
				await expect(call()).rejects.toThrow(/water purveyor only/i);
			}
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			for (const call of everyProcedure(ids.orphanedWpAdmin)) {
				await expect(call()).rejects.toThrow(/no water purveyor/i);
			}
		});

		it("admits every WP role, including an Employee", async () => {
			// Reading the dashboard is not an administrative act. The role split on
			// this platform governs *corrections*, and that lives on the submitted
			// tests router's two mutations.
			await expect(
				callerFor(ids.employeeA).dashboard.dashboardMetrics(),
			).resolves.toMatchObject({ totalAssets: expect.any(Number) });
		});
	});

	describe("dashboardMetrics", () => {
		it("counts only the caller's own assets", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.dashboardMetrics();
			const fromB = await callerFor(ids.adminB).dashboard.dashboardMetrics();

			expect(fromA.totalAssets).toBe(3);
			expect(fromB.totalAssets).toBe(2);
		});

		it("counts past-due assets per tenant, not across both", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.dashboardMetrics();
			const fromB = await callerFor(ids.adminB).dashboard.dashboardMetrics();

			expect(fromA.pastDue).toBe(2);
			expect(fromB.pastDue).toBe(1);
		});

		it("counts submitted reports per tenant, drafts excluded", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			// Seven submitted rows per tenant; the eighth is a draft.
			expect(fromA.submittedReports).toBe(7);

			const { rows } = await pool.query(
				"select count(*)::int as value from test_submissions where water_purveyor_id = $1 and status = 'draft'",
				[wpA],
			);
			expect(rows[0]?.value).toBe(1);
		});

		it("counts tests this month by test date, both month boundaries inclusive", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			// The 1st and the 30th of September. The 2026-08-05 row is the previous
			// month and the 2026-09-03 row is a draft — neither counts.
			expect(fromA.testsThisMonth).toBe(2);
			expect(fromA.month).toBe(THIS_MONTH.month);
		});

		it("does not count a draft dated this month", async () => {
			const before = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			const draft = await seedSubmission({
				waterPurveyorId: wpA,
				status: "draft",
				testDate: THIS_MONTH.start,
			});

			const after = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			expect(after.testsThisMonth).toBe(before.testsThisMonth);
			expect(after.submittedReports).toBe(before.submittedReports);

			await pool.query("delete from test_submissions where id = $1", [draft]);
		});

		it("counts a submitted test dated the last day of the month", async () => {
			const before = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			const edge = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: THIS_MONTH.end,
			});

			const after = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			expect(after.testsThisMonth).toBe(before.testsThisMonth + 1);

			await pool.query("delete from test_submissions where id = $1", [edge]);
		});

		it("counts no submitted test dated the first day of the next month", async () => {
			const before = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			const spill = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2026-10-01",
			});

			const after = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			expect(after.testsThisMonth).toBe(before.testsThisMonth);
			// It is still a submitted report, though — the month bound narrows one
			// card, not the whole tenant.
			expect(after.submittedReports).toBe(before.submittedReports + 1);

			await pool.query("delete from test_submissions where id = $1", [spill]);
		});

		it("counts a submitted test carrying no test date in no month", async () => {
			const before = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			const undated = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: null,
				testResult: null,
			});

			const after = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			expect(after.testsThisMonth).toBe(before.testsThisMonth);
			expect(after.submittedReports).toBe(before.submittedReports + 1);

			await pool.query("delete from test_submissions where id = $1", [undated]);
		});

		it("counts no-BIN submissions per tenant", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.dashboardMetrics();
			const fromB = await callerFor(ids.adminB).dashboard.dashboardMetrics();

			// Every seeded submission has a null `bfa_asset_id` — the fixture never
			// links one — so the count is every submitted row in the tenant. What
			// matters is that it is *that tenant's*, and that the draft is out.
			expect(fromA.noBinSubmissions).toBe(7);
			expect(fromB.noBinSubmissions).toBe(7);
		});

		it("drops a submission out of the no-BIN count once it is linked", async () => {
			const before = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			const linked = await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: activeA,
				testDate: "2026-07-07",
			});

			const after = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			expect(after.submittedReports).toBe(before.submittedReports + 1);
			expect(after.noBinSubmissions).toBe(before.noBinSubmissions);

			await pool.query("delete from test_submissions where id = $1", [linked]);
		});

		// The build plan's "submissions awaiting review" (§ 6.4.1), shipped as
		// `submittedReports` because the schema has no review lifecycle to drain.
		// This is the assertion that pins the confirmed definition: every
		// submitted row, and nothing about links or corrections.
		it("counts every submitted row as a submitted report, linked or not, corrected or not", async () => {
			const { rows } = await pool.query(
				"select count(*)::int as value from test_submissions where water_purveyor_id = $1 and status = 'submitted'",
				[wpA],
			);

			const metrics = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			expect(metrics.submittedReports).toBe(rows[0]?.value);
		});

		it("reconciles every card against the rows underneath it", async () => {
			const metrics = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			const { rows: assetRows } = await pool.query(
				`select count(*)::int as total,
				        (count(*) filter (where asset_status = 'past_due'))::int as past_due
				 from bfa_assets where water_purveyor_id = $1`,
				[wpA],
			);
			const { rows: submissionRows } = await pool.query(
				`select count(*)::int as submitted,
				        (count(*) filter (where test_date between $2 and $3))::int as this_month,
				        (count(*) filter (where bfa_asset_id is null))::int as no_bin
				 from test_submissions
				 where water_purveyor_id = $1 and status = 'submitted'`,
				[wpA, THIS_MONTH.start, THIS_MONTH.end],
			);

			expect(metrics).toMatchObject({
				totalAssets: assetRows[0]?.total,
				pastDue: assetRows[0]?.past_due,
				submittedReports: submissionRows[0]?.submitted,
				testsThisMonth: submissionRows[0]?.this_month,
				noBinSubmissions: submissionRows[0]?.no_bin,
			});
		});
	});

	describe("complianceTrend", () => {
		it("returns twelve chronological months, ending with the current one", async () => {
			const trend = await callerFor(ids.adminA).dashboard.complianceTrend();
			const months = trend.months.map((month) => month.month);

			expect(months).toHaveLength(12);
			expect(months).toEqual(TREND_WINDOW.months.map((month) => month.month));
			expect([...months].sort()).toEqual(months);
			expect(months[months.length - 1]).toBe(THIS_MONTH.month);
		});

		it("includes a month with no tests, at a null rate rather than zero", async () => {
			const trend = await callerFor(ids.adminA).dashboard.complianceTrend();
			const quiet = trend.months.find((month) => month.month === "2026-01");

			expect(quiet).toEqual({
				month: "2026-01",
				passCount: 0,
				failCount: 0,
				testedCount: 0,
				passRate: null,
			});
		});

		it("rates the current month from its own pass and fail", async () => {
			const trend = await callerFor(ids.adminA).dashboard.complianceTrend();
			const current = trend.months.find(
				(month) => month.month === THIS_MONTH.month,
			);

			// One pass on the 1st, one fail on the 30th. The draft on the 3rd is
			// not here, which is what keeps the rate from reading 66.7%.
			expect(current).toMatchObject({
				passCount: 1,
				failCount: 1,
				testedCount: 2,
				passRate: 50,
			});
		});

		it("leaves a month holding only an unrecorded result at a null rate", async () => {
			const trend = await callerFor(ids.adminA).dashboard.complianceTrend();
			const june = trend.months.find((month) => month.month === "2026-06");

			// The only June row has a null `test_result`. It is not a failure; it is
			// a record that never recorded one, and putting it in the denominator
			// would have shown 0%.
			expect(june).toMatchObject({ testedCount: 0, passRate: null });
		});

		it("includes the oldest month in the window and excludes the day before it", async () => {
			const trend = await callerFor(ids.adminA).dashboard.complianceTrend();
			const oldest = trend.months[0];

			expect(oldest?.month).toBe("2025-10");
			// The 2025-10-01 row is in; the 2025-09-30 row is one day outside the
			// window and appears in no month at all.
			expect(oldest).toMatchObject({ passCount: 1, testedCount: 1 });
			expect(trend.months.some((month) => month.month === "2025-09")).toBe(
				false,
			);
		});

		it("gives two purveyors independent trends", async () => {
			const extra = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2026-05-04",
				testResult: "fail",
			});

			const fromA = await callerFor(ids.adminA).dashboard.complianceTrend();
			const fromB = await callerFor(ids.adminB).dashboard.complianceTrend();

			const mayA = fromA.months.find((month) => month.month === "2026-05");
			const mayB = fromB.months.find((month) => month.month === "2026-05");

			expect(mayA).toMatchObject({ failCount: 1, passRate: 0 });
			expect(mayB).toMatchObject({ failCount: 0, passRate: null });

			await pool.query("delete from test_submissions where id = $1", [extra]);
		});

		it("reconciles each month against the rows underneath it", async () => {
			const trend = await callerFor(ids.adminA).dashboard.complianceTrend();

			const { rows } = await pool.query(
				`select to_char(test_date, 'YYYY-MM') as month,
				        (count(*) filter (where test_result = 'pass'))::int as pass_count,
				        (count(*) filter (where test_result = 'fail'))::int as fail_count
				 from test_submissions
				 where water_purveyor_id = $1
				   and status = 'submitted'
				   and test_result is not null
				   and test_date between $2 and $3
				 group by 1`,
				[wpA, TREND_WINDOW.start, TREND_WINDOW.end],
			);

			for (const row of rows) {
				expect(
					trend.months.find((month) => month.month === row.month),
				).toMatchObject({
					passCount: row.pass_count,
					failCount: row.fail_count,
				});
			}
		});

		it("returns twelve empty months for a purveyor with no tests at all", async () => {
			const emptyWp = randomUUID();
			const emptyAdmin = randomUUID();

			await pool.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Dashboard Fixture Empty', 'DASH-EMPTY', 'active')`,
				[emptyWp],
			);
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'Dashboard Fixture', 'wp_admin', 'active')`,
				[emptyAdmin, emptyWp],
			);

			const trend = await callerFor(emptyAdmin).dashboard.complianceTrend();

			expect(trend.months).toHaveLength(12);
			expect(trend.months.every((month) => month.passRate === null)).toBe(true);

			await pool.query("delete from profiles where id = $1", [emptyAdmin]);
			await pool.query("delete from water_purveyors where id = $1", [emptyWp]);
		});
	});

	describe("passFailBreakdown", () => {
		it("counts pass and fail inside the chosen range, per tenant", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-09-01",
				to: "2026-09-30",
			});

			expect(fromA).toMatchObject({
				from: "2026-09-01",
				to: "2026-09-30",
				pass: 1,
				fail: 1,
				total: 2,
			});
		});

		it("does not pick up the other purveyor's identical rows", async () => {
			const extra = await seedSubmission({
				waterPurveyorId: wpB,
				testDate: "2026-09-15",
				testResult: "pass",
			});

			const fromA = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-09-01",
				to: "2026-09-30",
			});
			const fromB = await callerFor(ids.adminB).dashboard.passFailBreakdown({
				from: "2026-09-01",
				to: "2026-09-30",
			});

			expect(fromA.pass).toBe(1);
			expect(fromB.pass).toBe(2);

			await pool.query("delete from test_submissions where id = $1", [extra]);
		});

		it("includes both bounds — the 1st to the 30th means the 30th", async () => {
			const inclusive = await callerFor(ids.adminA).dashboard.passFailBreakdown(
				{ from: "2026-09-30", to: "2026-09-30" },
			);

			expect(inclusive).toMatchObject({ pass: 0, fail: 1, total: 1 });
		});

		it("excludes the day after the upper bound", async () => {
			const narrowed = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-09-01",
				to: "2026-09-29",
			});

			expect(narrowed).toMatchObject({ pass: 1, fail: 0, total: 1 });
		});

		// The primary contract stays strictly pass and fail: a row with no result
		// is in neither count and not in `total`. It is reported, but one level
		// down, so a caller has to name `supplemental` to read it and cannot pick
		// it up by accident while summing a breakdown.
		it("counts an unrecorded result in neither bar, nor in the total", async () => {
			const june = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-06-01",
				to: "2026-06-30",
			});

			expect(june).toMatchObject({ pass: 0, fail: 0, total: 0 });
			expect(june.supplemental).toEqual({ unrecorded: 1 });
		});

		it("keeps total equal to pass plus fail, unrecorded rows and all", async () => {
			const wholeWindow = await callerFor(
				ids.adminA,
			).dashboard.passFailBreakdown({ from: "2025-10-01", to: "2026-09-30" });

			expect(wholeWindow.total).toBe(wholeWindow.pass + wholeWindow.fail);
			expect(wholeWindow.supplemental.unrecorded).toBeGreaterThan(0);
		});

		it("excludes drafts from the range", async () => {
			const before = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-09-01",
				to: "2026-09-30",
			});

			const draft = await seedSubmission({
				waterPurveyorId: wpA,
				status: "draft",
				testDate: "2026-09-15",
				testResult: "fail",
			});

			const after = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-09-01",
				to: "2026-09-30",
			});

			expect(after).toMatchObject({ pass: before.pass, fail: before.fail });

			await pool.query("delete from test_submissions where id = $1", [draft]);
		});

		it("returns a genuine zero for a range nothing falls in", async () => {
			const quiet = await callerFor(ids.adminA).dashboard.passFailBreakdown({
				from: "2026-01-01",
				to: "2026-01-31",
			});

			expect(quiet).toMatchObject({ pass: 0, fail: 0, total: 0 });
			expect(quiet.supplemental.unrecorded).toBe(0);
		});

		it("refuses a range that ends before it starts", async () => {
			await expect(
				callerFor(ids.adminA).dashboard.passFailBreakdown({
					from: "2026-09-30",
					to: "2026-09-01",
				}),
			).rejects.toThrow();
		});

		it("reconciles against the rows underneath it", async () => {
			const range = { from: "2025-10-01", to: "2026-09-30" };
			const breakdown = await callerFor(ids.adminA).dashboard.passFailBreakdown(
				range,
			);

			const { rows } = await pool.query(
				`select (count(*) filter (where test_result = 'pass'))::int as pass,
				        (count(*) filter (where test_result = 'fail'))::int as fail,
				        (count(*) filter (where test_result is null))::int as unrecorded
				 from test_submissions
				 where water_purveyor_id = $1
				   and status = 'submitted'
				   and test_date between $2 and $3`,
				[wpA, range.from, range.to],
			);

			expect(breakdown).toMatchObject({
				pass: rows[0]?.pass,
				fail: rows[0]?.fail,
			});
			expect(breakdown.supplemental.unrecorded).toBe(rows[0]?.unrecorded);
		});
	});

	describe("incomingReports", () => {
		it("shows two purveyors completely separate lists", async () => {
			const marker = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2027-12-31",
				submittedBinText: "ONLY-IN-A",
			});

			const fromA = await callerFor(ids.adminA).dashboard.incomingReports({});
			const fromB = await callerFor(ids.adminB).dashboard.incomingReports({});

			expect(fromA.map((row) => row.id)).toContain(marker);
			expect(fromB.map((row) => row.id)).not.toContain(marker);

			await pool.query("delete from test_submissions where id = $1", [marker]);
		});

		it("never lists a draft", async () => {
			const draft = await seedSubmission({
				waterPurveyorId: wpA,
				status: "draft",
				testDate: "2027-12-31",
			});

			const rows = await callerFor(ids.adminA).dashboard.incomingReports({});

			expect(rows.map((row) => row.id)).not.toContain(draft);

			await pool.query("delete from test_submissions where id = $1", [draft]);
		});

		it("orders newest test first, with undated rows last", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({
				limit: 20,
			});
			const dated = rows
				.map((row) => row.testDate)
				.filter((date): date is string => date !== null);

			expect([...dated].sort().reverse()).toEqual(dated);
		});

		it("honours the limit, so the home preview stays a preview", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({
				limit: 3,
			});

			expect(rows).toHaveLength(3);
		});

		it("defaults to five rows", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports();

			expect(rows).toHaveLength(5);
		});

		it("carries the typed BIN for a no-BIN submission, and no asset BIN", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({
				limit: 20,
			});
			const noBin = rows.find(
				(row) => row.submittedBinText === "TYPED-BIN-404",
			);

			expect(noBin).toBeDefined();
			expect(noBin?.bin).toBeNull();
		});

		it("carries the asset's BIN once a submission is linked", async () => {
			const linked = await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: activeA,
				testDate: "2027-12-30",
			});

			const rows = await callerFor(ids.adminA).dashboard.incomingReports({});
			const row = rows.find((candidate) => candidate.id === linked);

			expect(row?.bin).toBe("DASH-CURRENT");

			await pool.query("delete from test_submissions where id = $1", [linked]);
		});

		it("names the certifier who filed it", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({});

			expect(rows[0]?.certifierName).toBe("Dashboard Fixture");
		});

		// The promise the whole "incoming reports" panel rests on: its rows are
		// the head of the Submitted Tests list, so clicking one lands on that
		// screen's document for the same record.
		it("matches the head of listSubmittedTests exactly", async () => {
			const incoming = await callerFor(ids.adminA).dashboard.incomingReports({
				limit: 5,
			});
			const list = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 5 });

			expect(incoming.map((row) => row.id)).toEqual(
				list.rows.map((row) => row.id),
			);
		});
	});

	/**
	 * A submission in WP A whose `bfa_asset_id` points at an asset in WP B.
	 *
	 * Not a state any procedure can produce — `linkSubmissionAsset` refuses it
	 * and `0009_test_submission_asset_tenancy` put the same clause in the row
	 * policy's WITH CHECK — so it is seeded straight through SQL. The question is
	 * what the read path does when it meets one anyway, which `0009` explicitly
	 * left possible by keeping the clause out of USING so a crossed row stays
	 * reachable and repairable.
	 *
	 * The foreign asset carries values that appear nowhere else in the fixture,
	 * so a leak cannot be mistaken for a plausible row. The mirrored BINs the
	 * rest of this suite uses would hide exactly this bug.
	 */
	describe("a submission whose asset link crosses tenants", () => {
		const foreignAsset = randomUUID();
		const crossLinked = randomUUID();

		beforeAll(async () => {
			await pool.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date, asset_status)
				 values ($1, $2, 'LEAK-CANARY-BIN', 'DC', '99 Foreign Street', '2027-06-01', 'active')`,
				[foreignAsset, wpB],
			);

			await seedSubmission({
				id: crossLinked,
				waterPurveyorId: wpA,
				bfaAssetId: foreignAsset,
				// Dated far ahead so it sits at the head of the list the home screen
				// actually shows, rather than being paged out of the assertion.
				testDate: "2027-12-31",
				submittedBinText: "TYPED-BY-CERTIFIER",
			});
		});

		afterAll(async () => {
			await pool.query("delete from test_submissions where id = $1", [
				crossLinked,
			]);
			await pool.query("delete from bfa_assets where id = $1", [foreignAsset]);
		});

		it("still surfaces the row to the purveyor that owns the submission", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({});

			expect(rows.map((row) => row.id)).toContain(crossLinked);
		});

		it("carries none of the foreign asset's fields", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({});
			const row = rows.find((candidate) => candidate.id === crossLinked);

			expect(row?.bin).toBeNull();
			expect(JSON.stringify(row)).not.toContain("LEAK-CANARY-BIN");
			expect(JSON.stringify(row)).not.toContain("99 Foreign Street");
		});

		it("reads exactly as an unlinked submission does", async () => {
			const rows = await callerFor(ids.adminA).dashboard.incomingReports({});
			const row = rows.find((candidate) => candidate.id === crossLinked);

			// A null BIN beside the certifier's typed text is the shape the home
			// list already renders as "Not linked to an asset" — so the failure
			// mode lands on copy that exists rather than on a blank.
			expect(row?.submittedBinText).toBe("TYPED-BY-CERTIFIER");
		});

		it("stays invisible to the purveyor whose asset it points at", async () => {
			const rows = await callerFor(ids.adminB).dashboard.incomingReports({
				limit: 20,
			});

			expect(rows.map((row) => row.id)).not.toContain(crossLinked);
		});

		// The two paths have to agree, because one is a link into the other: a
		// reader clicking this row on the home screen lands on the document view,
		// and a BIN withheld in one place and shown in the other would be the
		// same leak with an extra click in front of it.
		it("agrees with the Submitted Tests list about what it withholds", async () => {
			const fromDashboard = await callerFor(
				ids.adminA,
			).dashboard.incomingReports({});
			const fromList = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });

			const dashboardRow = fromDashboard.find(
				(candidate) => candidate.id === crossLinked,
			);
			const listRow = fromList.rows.find(
				(candidate) => candidate.id === crossLinked,
			);

			expect(dashboardRow).toBeDefined();
			expect(listRow).toBeDefined();
			expect(dashboardRow?.bin).toBeNull();
			expect(listRow?.bin).toBeNull();
		});

		it("counts in the tenant's own figures, and not in the other's", async () => {
			// The metric cards never join assets, so they were never at risk — but
			// the row is a real submission belonging to A, and it has to keep
			// counting as one on the screen the list sits beside.
			const fromA = await callerFor(ids.adminA).dashboard.dashboardMetrics();
			const fromB = await callerFor(ids.adminB).dashboard.dashboardMetrics();

			expect(fromA.submittedReports).toBe(8);
			expect(fromB.submittedReports).toBe(7);
			// Linked in the column, unlinked in every practical sense — and the
			// No-BIN card reads the column, so it does not count here.
			expect(fromA.noBinSubmissions).toBe(7);
		});
	});

	describe("delinquentAssets", () => {
		it("lists only the caller's own past-due assets", async () => {
			const fromA = await callerFor(ids.adminA).dashboard.delinquentAssets({});
			const fromB = await callerFor(ids.adminB).dashboard.delinquentAssets({});

			expect(fromA.map((row) => row.id).sort()).toEqual(
				[pastDueA, pastDueA2].sort(),
			);
			expect(fromB.map((row) => row.id)).toEqual([pastDueB]);
		});

		it("excludes assets that are not past due", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});

			expect(rows.map((row) => row.id)).not.toContain(activeA);
		});

		it("excludes a due-soon asset — the card is past due, not nearly due", async () => {
			await pool.query(
				"update bfa_assets set asset_status = 'due_soon' where id = $1",
				[activeA],
			);

			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});

			expect(rows.map((row) => row.id)).not.toContain(activeA);

			await pool.query(
				"update bfa_assets set asset_status = 'active' where id = $1",
				[activeA],
			);
		});

		it("puts the worst first — oldest annual test date at the top", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});

			expect(rows.map((row) => row.id)).toEqual([pastDueA, pastDueA2]);
		});

		it("sorts a past-due asset with no test date last, not first", async () => {
			await pool.query(
				"update bfa_assets set annual_test_date = null where id = $1",
				[pastDueA],
			);

			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});

			expect(rows[rows.length - 1]?.id).toBe(pastDueA);

			await pool.query(
				"update bfa_assets set annual_test_date = '2025-03-01' where id = $1",
				[pastDueA],
			);
		});

		it("identifies the asset well enough to act on", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({});

			expect(rows[0]).toMatchObject({
				bin: "DASH-OVERDUE-1",
				serviceAddress: "1 Shared Way",
				annualTestDate: "2025-03-01",
			});
		});

		it("honours the limit", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 1,
			});

			expect(rows).toHaveLength(1);
		});

		it("reconciles against the rows underneath it", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});
			const { rows: counted } = await pool.query(
				"select count(*)::int as value from bfa_assets where water_purveyor_id = $1 and asset_status = 'past_due'",
				[wpA],
			);
			const metrics = await callerFor(ids.adminA).dashboard.dashboardMetrics();

			// The list and the card are two queries over the same predicate, so a
			// disagreement between them is the bug this asserts against.
			expect(rows).toHaveLength(counted[0]?.value);
			expect(metrics.pastDue).toBe(counted[0]?.value);
		});
	});

	/**
	 * A past-due asset in WP A whose `current_customer_id` names a customer in
	 * WP B.
	 *
	 * The same class of hole as the crossed asset link above, one table further
	 * along: the asset is scoped by `bfa_assets.water_purveyor_id`, but the
	 * foreign key on `current_customer_id` proves only that the customer exists,
	 * not whose it is. `assignCustomer` refuses to create such a link, so this is
	 * seeded straight through SQL.
	 *
	 * It matters most on *this* list. The delinquent queue exists to be acted on
	 * — the next step on one of these rows is contacting the occupant — so the
	 * occupant's name is the field a reader is most likely to use, and the one
	 * that must not belong to somebody else's tenant.
	 *
	 * Declared last in the file so its extra past-due row cannot disturb the
	 * count assertions above; `afterAll` removes it either way.
	 */
	describe("a past-due asset whose customer link crosses tenants", () => {
		const foreignCustomer = randomUUID();
		const mispointedAsset = randomUUID();

		beforeAll(async () => {
			await pool.query(
				`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
				 values ($1, $2, 'Leak Canary Holdings', 'canary@example.com', 'standard', 'active')`,
				[foreignCustomer, wpB],
			);

			await pool.query(
				`insert into bfa_assets
				   (id, water_purveyor_id, bin, current_customer_id, bfa_type, service_address, annual_test_date, asset_status)
				 values ($1, $2, 'CROSS-TENANT-OCCUPANT', $3, 'RP', '5 Mispointed Lane', '2024-01-01', 'past_due')`,
				[mispointedAsset, wpA, foreignCustomer],
			);
		});

		afterAll(async () => {
			await pool.query("delete from bfa_assets where id = $1", [
				mispointedAsset,
			]);
			await pool.query("delete from customers where id = $1", [
				foreignCustomer,
			]);
		});

		it("still lists the asset for the purveyor that owns it", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});

			// Dated 2024, so it sorts to the top of "worst first" — and this list
			// is the only place somebody would go to repair it.
			expect(rows.map((row) => row.id)).toContain(mispointedAsset);
		});

		it("shows no occupant rather than a foreign one", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});
			const row = rows.find((candidate) => candidate.id === mispointedAsset);

			expect(row?.currentCustomerName).toBeNull();
			expect(JSON.stringify(rows)).not.toContain("Leak Canary Holdings");
		});

		it("keeps the asset's own fields, which are this purveyor's to read", async () => {
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});
			const row = rows.find((candidate) => candidate.id === mispointedAsset);

			// Only the customer is withheld. Blanking the asset too would make the
			// queue useless for the row that most needs attention.
			expect(row).toMatchObject({
				bin: "CROSS-TENANT-OCCUPANT",
				serviceAddress: "5 Mispointed Lane",
				annualTestDate: "2024-01-01",
			});
		});

		it("stays invisible to the purveyor whose customer it points at", async () => {
			const rows = await callerFor(ids.adminB).dashboard.delinquentAssets({
				limit: 20,
			});

			expect(rows.map((row) => row.id)).not.toContain(mispointedAsset);
		});

		it("still counts as past due for the purveyor that owns it", async () => {
			// The metric never joins customers, so it was never at risk — but the
			// asset is genuinely A's and genuinely past due, and the card has to
			// keep agreeing with the list beside it.
			const metrics = await callerFor(ids.adminA).dashboard.dashboardMetrics();
			const rows = await callerFor(ids.adminA).dashboard.delinquentAssets({
				limit: 20,
			});

			expect(metrics.pastDue).toBe(3);
			expect(rows).toHaveLength(3);
		});
	});
});
