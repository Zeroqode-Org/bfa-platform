import { randomUUID } from "node:crypto";

import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `superAdmin.setFeatureFlag` against real Postgres: the flag row it upserts,
 * who may call it, and what switching a feature on restores.
 *
 * The restore rule is the part only real rows can prove — "newest job per
 * asset, and only when that job was cancelled by the switch-off" is a
 * `distinct on` and a lock, not something a mocked database would check. Each
 * asset below is one shape of history, and every one but the flag-cancelled
 * ones must come out untouched.
 *
 * Opt-in: writes real rows; runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wp = randomUUID();
const otherWp = randomUUID();

const ids = {
	superAdmin: randomUUID(),
	wpAdmin: randomUUID(),
};

/** Far enough out that no stage of any chain here is due during the suite. */
const TEST_DATE = "2031-03-15";

/** Two years and more in the past: every stage of its chain is already due. */
const OVERDUE_DATE = "2024-06-04";

const FEATURE_DISABLED =
	"Automated notices are switched off for this water purveyor.";
const PASSING_TEST =
	"A passing test was submitted for this assembly, which ends the escalation.";
const AG_FEATURE_DISABLED =
	"The AG renewal notice is switched off for this water purveyor.";

let pool: pg.Pool;
let noticeRunAt: typeof import("../lib/notice-schedule")["noticeRunAt"];
let cancelRunningJobWhileFeatureOff: typeof import("./jobs")["cancelRunningJobWhileFeatureOff"];

type Caller = {
	superAdmin: {
		setFeatureFlag: (input: {
			waterPurveyorId: string;
			feature: "automated_notices" | "ag_renewal_notice";
			isEnabled: boolean;
		}) => Promise<{ isEnabled: boolean; restored: number }>;
		listWaterPurveyors: () => Promise<
			{
				id: string;
				features: Record<
					string,
					{ isEnabled: boolean; updatedByName: string | null }
				>;
			}[]
		>;
	};
};

let callerFor: (profileId: string) => Caller;

/** One asset of `wp` (or another purveyor), with whatever job history it is given. */
async function seedAsset({
	purveyor = wp,
	bin = `FR-${randomUUID().slice(0, 8)}`,
	annualTestDate = TEST_DATE,
	jobs,
}: {
	purveyor?: string;
	bin?: string | null;
	annualTestDate?: string;
	jobs: { type: string; status: string; error?: string; minutesAgo: number }[];
}) {
	const assetId = randomUUID();

	await pool.query(
		`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date)
		 values ($1, $2, $3, 'RP', '1 Restore Lane', $4)`,
		[assetId, purveyor, bin, annualTestDate],
	);

	for (const job of jobs) {
		await pool.query(
			`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status, last_error, created_at)
			 values ($1, $2, $3, now(), $4, $5, now() - make_interval(mins => $6))`,
			[
				job.type,
				assetId,
				purveyor,
				job.status,
				job.error ?? null,
				job.minutesAgo,
			],
		);
	}

	return assetId;
}

async function liveJobs(assetId: string) {
	const { rows } = await pool.query<{ job_type: string; run_at: Date }>(
		`select job_type, run_at from scheduled_jobs
		  where bfa_asset_id = $1 and status in ('pending', 'running')`,
		[assetId],
	);

	return rows;
}

describeDb("superAdmin.setFeatureFlag", () => {
	const assets: Record<string, string> = {};

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
		({ noticeRunAt } = await import("../lib/notice-schedule"));
		({ cancelRunningJobWhileFeatureOff } = await import("./jobs"));

		const { t } = await import("../index");
		const { appRouter } = await import("../routers/index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId) =>
			createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as unknown as Caller;

		await pool.query(
			`insert into water_purveyors (id, company_name, status)
			 values ($1, 'Restore Water Works', 'active'), ($2, 'Other Water Works', 'active')`,
			[wp, otherWp],
		);
		await pool.query(
			`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
			 values ($1, null, 'Restore Super', 'super_admin', 'active'),
			        ($2, $3, 'Restore Admin', 'wp_admin', 'active')`,
			[ids.superAdmin, ids.wpAdmin, wp],
		);

		// Cancelled by the switch-off at the reminder: restored.
		assets.reminder = await seedAsset({
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 10,
				},
			],
		});
		// A reminder went out while the flag was on; the late notice was then
		// cancelled by the switch-off: restored at the late notice, not the
		// reminder.
		assets.lateNotice = await seedAsset({
			jobs: [
				{ type: "reminder", status: "completed", minutesAgo: 20 },
				{
					type: "late_notice_1",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 10,
				},
			],
		});
		// Long overdue: every stage's day has passed. Restored as the final
		// notice alone, not as a reminder followed by three catch-up notices.
		assets.overdue = await seedAsset({
			annualTestDate: OVERDUE_DATE,
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 10,
				},
			],
		});
		// Flag-cancelled once, then a passing test had the last word: untouched.
		assets.passed = await seedAsset({
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 20,
				},
				{
					type: "reminder",
					status: "cancelled",
					error: PASSING_TEST,
					minutesAgo: 10,
				},
			],
		});
		// The whole chain went out: untouched, so no notice is sent twice.
		assets.finished = await seedAsset({
			jobs: [{ type: "final_notice", status: "completed", minutesAgo: 10 }],
		});
		// Already has a live reminder: untouched, and no duplicate.
		assets.live = await seedAsset({
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 20,
				},
				{ type: "reminder", status: "pending", minutesAgo: 10 },
			],
		});
		// Lost its BIN since: nothing to name in a notice, untouched.
		assets.noBin = await seedAsset({
			bin: null,
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 10,
				},
			],
		});
		// Another purveyor's flag-cancelled asset: never reached.
		assets.otherTenant = await seedAsset({
			purveyor: otherWp,
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 10,
				},
			],
		});
	});

	afterAll(async () => {
		if (!pool) return;

		const wps = [[wp, otherWp]];

		await pool.query(
			"delete from scheduled_jobs where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from customers where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from wp_feature_flags where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query(
			"delete from water_purveyors where id = any($1::uuid[])",
			wps,
		);
		await pool.end();
	});

	it("refuses every caller but the Super-Admin", async () => {
		await expect(
			callerFor(ids.wpAdmin).superAdmin.setFeatureFlag({
				waterPurveyorId: wp,
				feature: "automated_notices",
				isEnabled: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const { rows } = await pool.query(
			"select 1 from wp_feature_flags where water_purveyor_id = $1",
			[wp],
		);
		expect(rows).toHaveLength(0);
	});

	it("lists a purveyor with no flag rows as explicitly off", async () => {
		const list = await callerFor(
			ids.superAdmin,
		).superAdmin.listWaterPurveyors();
		const row = list.find((purveyor) => purveyor.id === wp);

		expect(row?.features).toEqual({
			automated_notices: {
				isEnabled: false,
				updatedAt: null,
				updatedByName: null,
			},
			ag_renewal_notice: {
				isEnabled: false,
				updatedAt: null,
				updatedByName: null,
			},
		});
	});

	it("switching automated notices on restores exactly the stages the switch-off cancelled", async () => {
		const logs: Record<string, unknown>[] = [];
		vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			try {
				logs.push(JSON.parse(String(value)));
			} catch {
				// Not a structured line.
			}
		});

		const result = await callerFor(ids.superAdmin).superAdmin.setFeatureFlag({
			waterPurveyorId: wp,
			feature: "automated_notices",
			isEnabled: true,
		});

		vi.restoreAllMocks();

		expect(result).toMatchObject({ isEnabled: true, restored: 3 });

		expect(await liveJobs(assets.reminder as string)).toEqual([
			{ job_type: "reminder", run_at: noticeRunAt(TEST_DATE, "reminder") },
		]);
		expect(await liveJobs(assets.lateNotice as string)).toEqual([
			{
				job_type: "late_notice_1",
				run_at: noticeRunAt(TEST_DATE, "late_notice_1"),
			},
		]);
		expect(await liveJobs(assets.overdue as string)).toEqual([
			{
				job_type: "final_notice",
				run_at: noticeRunAt(OVERDUE_DATE, "final_notice"),
			},
		]);
		expect(await liveJobs(assets.passed as string)).toEqual([]);
		expect(await liveJobs(assets.finished as string)).toEqual([]);
		expect(await liveJobs(assets.live as string)).toHaveLength(1);
		expect(await liveJobs(assets.noBin as string)).toEqual([]);
		expect(await liveJobs(assets.otherTenant as string)).toEqual([]);

		const { rows } = await pool.query(
			`select is_enabled, updated_by_profile_id from wp_feature_flags
			  where water_purveyor_id = $1 and feature = 'automated_notices'`,
			[wp],
		);
		expect(rows).toEqual([
			{ is_enabled: true, updated_by_profile_id: ids.superAdmin },
		]);

		expect(
			logs.filter((line) => line.event === "feature_flag_changed"),
		).toEqual([
			expect.objectContaining({
				wp_id: wp,
				feature: "automated_notices",
				is_enabled: true,
				restored_jobs: 3,
			}),
		]);
		expect(
			logs.filter(
				(line) =>
					line.event === "scheduler_job_scheduled" &&
					line.trigger === "feature_enabled",
			),
		).toHaveLength(3);
	});

	it("switching it on again changes nothing and restores nothing", async () => {
		const before = await pool.query(
			"select count(*)::int as n from scheduled_jobs where water_purveyor_id = $1",
			[wp],
		);

		const result = await callerFor(ids.superAdmin).superAdmin.setFeatureFlag({
			waterPurveyorId: wp,
			feature: "automated_notices",
			isEnabled: true,
		});

		const after = await pool.query(
			"select count(*)::int as n from scheduled_jobs where water_purveyor_id = $1",
			[wp],
		);

		expect(result.restored).toBe(0);
		expect(after.rows[0].n).toBe(before.rows[0].n);
	});

	it("shows who switched it in the list", async () => {
		const list = await callerFor(
			ids.superAdmin,
		).superAdmin.listWaterPurveyors();
		const row = list.find((purveyor) => purveyor.id === wp);

		expect(row?.features.automated_notices).toMatchObject({
			isEnabled: true,
			updatedByName: "Restore Super",
		});
	});

	it("a second 'on' writes no flag change but restores an asset stranded since", async () => {
		const stranded = await seedAsset({
			jobs: [
				{
					type: "reminder",
					status: "cancelled",
					error: FEATURE_DISABLED,
					minutesAgo: 1,
				},
			],
		});

		const result = await callerFor(ids.superAdmin).superAdmin.setFeatureFlag({
			waterPurveyorId: wp,
			feature: "automated_notices",
			isEnabled: true,
		});

		expect(result).toMatchObject({ changed: false, restored: 1 });
		expect(await liveJobs(stranded)).toEqual([
			{ job_type: "reminder", run_at: noticeRunAt(TEST_DATE, "reminder") },
		]);
	});

	it("a handler does not cancel for the flag once it is on again", async () => {
		const asset = await seedAsset({
			jobs: [{ type: "reminder", status: "running", minutesAgo: 1 }],
		});
		const {
			rows: [job],
		} = await pool.query<{ id: string }>(
			"select id from scheduled_jobs where bfa_asset_id = $1",
			[asset],
		);

		// The flag is on here (switched on above): the job is left to send.
		expect(
			await cancelRunningJobWhileFeatureOff({
				jobId: job?.id as string,
				waterPurveyorId: wp,
				feature: "automated_notices",
				reason: FEATURE_DISABLED,
			}),
		).toBe("enabled");
		expect(await liveJobs(asset)).toHaveLength(1);

		await pool.query(
			"update wp_feature_flags set is_enabled = false where water_purveyor_id = $1 and feature = 'automated_notices'",
			[wp],
		);

		expect(
			await cancelRunningJobWhileFeatureOff({
				jobId: job?.id as string,
				waterPurveyorId: wp,
				feature: "automated_notices",
				reason: FEATURE_DISABLED,
			}),
		).toBe("cancelled");
		expect(await liveJobs(asset)).toEqual([]);

		await pool.query(
			"update wp_feature_flags set is_enabled = true where water_purveyor_id = $1 and feature = 'automated_notices'",
			[wp],
		);
	});

	it("switching it off writes only the flag; live jobs cancel themselves when they run", async () => {
		const result = await callerFor(ids.superAdmin).superAdmin.setFeatureFlag({
			waterPurveyorId: wp,
			feature: "automated_notices",
			isEnabled: false,
		});

		expect(result).toMatchObject({ isEnabled: false, restored: 0 });
		expect(await liveJobs(assets.reminder as string)).toHaveLength(1);
	});

	it("switching the AG renewal notice on restores a flag-cancelled renewal for an agricultural customer", async () => {
		const customerId = randomUUID();
		await pool.query(
			`insert into customers (id, water_purveyor_id, name, email, rate_category, ag_renewal_date)
			 values ($1, $2, 'Restore Farm', $3, 'agricultural', $4)`,
			[customerId, wp, `farm-${customerId.slice(0, 8)}@example.com`, TEST_DATE],
		);
		await pool.query(
			`insert into scheduled_jobs (job_type, customer_id, water_purveyor_id, ag_renewal_date, run_at, status, last_error)
			 values ('ag_renewal', $1, $2, $3, now(), 'cancelled', $4)`,
			[customerId, wp, TEST_DATE, AG_FEATURE_DISABLED],
		);

		const result = await callerFor(ids.superAdmin).superAdmin.setFeatureFlag({
			waterPurveyorId: wp,
			feature: "ag_renewal_notice",
			isEnabled: true,
		});

		expect(result.restored).toBe(1);

		const { rows } = await pool.query(
			`select ag_renewal_date from scheduled_jobs
			  where customer_id = $1 and status = 'pending'`,
			[customerId],
		);
		expect(rows).toHaveLength(1);
	});
});
