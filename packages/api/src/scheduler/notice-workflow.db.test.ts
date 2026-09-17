import { randomUUID } from "node:crypto";

import { scheduledJobs } from "@bfa-platform/db/schema";
import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import type { inferProcedureInput } from "@trpc/server";
import { and, eq } from "drizzle-orm";
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

import {
	addCalendarDays,
	addCalendarMonths,
	honoluluDayStart,
	honoluluToday,
} from "../lib/honolulu-dates";
import type { NoticeType } from "../lib/notice-defaults";
import {
	CERTIFIER_LIST_HEADING,
	PLATFORM_DEFAULT_NOTICE_TEMPLATES,
} from "../lib/notice-defaults";
import { noticeRunAt } from "../lib/notice-schedule";
import type { AppRouter } from "../routers/index";
import { MAX_JOB_ATTEMPTS, STALE_RUNNING_AFTER_MS } from "./config";
import type { ScheduledJob } from "./jobs";

/**
 * Everything that reaches Postgres is imported inside `beforeAll`, not at the
 * top of the file.
 *
 * `@bfa-platform/db` validates the whole server env the moment it is imported,
 * and a plain `npm test` deliberately has none of it — `vitest.setup.ts` does
 * not even look for `apps/web/.env.local` unless `RUN_DB_TESTS=1`. A top-level
 * import would therefore fail *collection* of this file on the offline run,
 * which is worse than the suite being skipped: it turns an opt-out into a
 * broken build. The same reason the router suites load `../index` lazily.
 */
let db: typeof import("@bfa-platform/db")["db"];
let runNoticeJob: typeof import("./notice-handler")["runNoticeJob"];
let claimDueJobs: typeof import("./jobs")["claimDueJobs"];
let runSchedulerTick: typeof import("./index")["runSchedulerTick"];
let recoverInterruptedJobs: typeof import("./index")["recoverInterruptedJobs"];
let recomputeAssetStatuses: typeof import("./index")["recomputeAssetStatuses"];
let reconcileAssetNoticeChain: typeof import("./notice-chain")["reconcileAssetNoticeChain"];

/**
 * Workflow 1 — the reminder and the escalating late notices — against real
 * Postgres.
 *
 * Almost nothing here can be tested any other way. What the feature promises is
 * a sequence of conditional writes (`pending → running` claimed once, `sent_at`
 * claimed once, a completion that refuses a cancelled row) and a set of reads
 * resolved *at send time* against whatever the asset looks like then. A test
 * with a mocked database would assert that this file's own queries were called,
 * which is the one thing that is not in doubt.
 *
 * Two purveyors are seeded. `wpA` has `automated_notices` switched on, `wpB` has
 * no flag row at all — the default state of a new tenant, and the state the
 * handler must read as "off". Their customers, assets and certifiers are
 * deliberately interchangeable, so a leak between them looks like a leak rather
 * than like a plausible row.
 *
 * Each test registers its own asset, and `afterEach` withdraws whatever is still
 * live, so a tick in one test cannot claim a job another test is about to make
 * an assertion about.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

type Assets = AppRouter["assets"];
type SubmittedTests = AppRouter["submittedTests"];
type CreateAssetInput = inferProcedureInput<Assets["createAsset"]>;
type UpdateAssetInput = inferProcedureInput<Assets["updateAsset"]>;

const wpA = randomUUID();
const wpB = randomUUID();

const ids = {
	adminA: randomUUID(),
	adminB: randomUUID(),
	certActiveProfile: randomUUID(),
	certRevokedProfile: randomUUID(),
	certBlockedProfile: randomUUID(),
	certOtherWpProfile: randomUUID(),
};

const certifierIds = {
	active: randomUUID(),
	revoked: randomUUID(),
	blocked: randomUUID(),
	otherWp: randomUUID(),
};

const customerIds = {
	/** Active, in wpA. The ordinary recipient. */
	primary: randomUUID(),
	/** Active, in wpA. Used to prove routing follows a reassignment. */
	replacement: randomUUID(),
	/** Suspended, in wpA. Holds an asset's whole pipeline. */
	suspended: randomUUID(),
	/** Active, in wpA, with markup in the name — proves the body is escaped. */
	markup: randomUUID(),
	/** Active, in wpB. Must never receive wpA's mail. */
	foreign: randomUUID(),
};

/** Today, six months ago, and a year out — in Hawaii, which is what schedules. */
const today = honoluluToday();
const longOverdueDate = addCalendarMonths(today, -6);
const futureDate = addCalendarMonths(today, 12);

const CUSTOM_REMINDER_SUBJECT = "Test due {{due_date}} at {{service_address}}";
const CUSTOM_REMINDER_BODY = [
	"Aloha {{customer_name}},",
	"",
	"Your {{bfa_type}} assembly, BIN {{bin}}, is due on {{due_date}}.",
	"",
	"{{wp_name}}",
].join("\n");

let pool: pg.Pool;
let binCounter = 0;

let callerFor: (profileId: string) => {
	assets: {
		createAsset: (input: CreateAssetInput) => Promise<{
			id: string;
			bin: string;
			bfaType: string;
			serviceAddress: string;
			make: string | null;
			model: string | null;
			serialNumber: string | null;
			size: string | null;
			assemblyLocation: string | null;
			annualTestDate: string | null;
		}>;
		updateAsset: (input: UpdateAssetInput) => Promise<{ id: string }>;
		assignCustomer: (
			input: inferProcedureInput<Assets["assignCustomer"]>,
		) => Promise<unknown>;
	};
	submittedTests: {
		updateSubmittedTest: (
			input: inferProcedureInput<SubmittedTests["updateSubmittedTest"]>,
		) => Promise<unknown>;
		linkSubmissionAsset: (
			input: inferProcedureInput<SubmittedTests["linkSubmissionAsset"]>,
		) => Promise<unknown>;
	};
};

/** Collects the structured JSON lines the code under test emits. */
function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		try {
			lines.push(JSON.parse(String(value)));
		} catch {
			// Not one of ours. Swallowed rather than failing the test on it.
		}
	});

	return lines;
}

/** The console driver's own delivery lines — one per message that went out. */
function deliveries(lines: Record<string, unknown>[], to?: string) {
	return lines.filter(
		(line) =>
			line.event === "email_console_delivery" && (!to || line.to === to),
	);
}

function eventsNamed(lines: Record<string, unknown>[], event: string) {
	return lines.filter((line) => line.event === event);
}

/** A well-formed asset, so nothing in a refusal can be about validation. */
function newAsset(overrides: Partial<CreateAssetInput> = {}): CreateAssetInput {
	binCounter += 1;

	return {
		bin: `WF1-${binCounter}-${randomUUID().slice(0, 6)}`,
		bfaType: "RP",
		serviceAddress: "12 Kalani Street",
		annualTestDate: longOverdueDate,
		...overrides,
	} as CreateAssetInput;
}

/** The whole record, as the edit form sends it. */
function asUpdate(
	asset: Awaited<
		ReturnType<ReturnType<typeof callerFor>["assets"]["createAsset"]>
	>,
	overrides: Partial<UpdateAssetInput> = {},
): UpdateAssetInput {
	return {
		id: asset.id,
		bin: asset.bin,
		bfaType: asset.bfaType,
		serviceAddress: asset.serviceAddress,
		make: asset.make,
		model: asset.model,
		serialNumber: asset.serialNumber,
		size: asset.size,
		assemblyLocation: asset.assemblyLocation,
		annualTestDate: asset.annualTestDate as string,
		...overrides,
	} as UpdateAssetInput;
}

async function jobsFor(assetId: string) {
	const { rows } = await pool.query<{
		id: string;
		job_type: string;
		status: string;
		run_at: Date;
		attempts: number;
		last_error: string | null;
		sent_at: Date | null;
		completed_at: Date | null;
	}>(
		`select id, job_type, status, run_at, attempts, last_error, sent_at, completed_at
		   from scheduled_jobs where bfa_asset_id = $1
		  order by created_at, job_type`,
		[assetId],
	);

	return rows;
}

async function liveJobFor(assetId: string) {
	const rows = await jobsFor(assetId);
	const live = rows.filter(
		(row) => row.status === "pending" || row.status === "running",
	);

	expect(live).toHaveLength(1);

	return live[0] as NonNullable<(typeof live)[0]>;
}

/**
 * Claims one specific job and runs its handler.
 *
 * The claim is scoped to the row rather than going through `claimDueJobs`, so a
 * test asserting on one asset's chain cannot be disturbed by another asset's
 * due job. The atomic claim has tests of its own further down — this helper is
 * about the handler.
 */
async function runStage(assetId: string, { now = new Date() } = {}) {
	const live = await liveJobFor(assetId);

	const [claimed] = await db
		.update(scheduledJobs)
		.set({ status: "running" })
		.where(
			and(eq(scheduledJobs.id, live.id), eq(scheduledJobs.status, "pending")),
		)
		.returning();

	expect(claimed).toBeDefined();

	const job = claimed as ScheduledJob;
	const outcome = await runNoticeJob(job, job.jobType as NoticeType, { now });

	return { job, outcome };
}

describeDb("Workflow 1 — reminder and escalating late notices", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		({ db } = await import("@bfa-platform/db"));
		({ runNoticeJob } = await import("./notice-handler"));
		({ claimDueJobs } = await import("./jobs"));
		({ reconcileAssetNoticeChain } = await import("./notice-chain"));
		({ runSchedulerTick, recoverInterruptedJobs, recomputeAssetStatuses } =
			await import("./index"));

		const { t } = await import("../index");
		const { appRouter } = await import("../routers/index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as ReturnType<typeof callerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Kalani Water Works', 'WF1-A', 'active'),
			        ($2, 'Kalani Water Works', 'WF1-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string, string, string][] = [
			[ids.adminA, wpA, "Aria Admin", "wp_admin", "active"],
			[ids.adminB, wpB, "Bruno Admin", "wp_admin", "active"],
			[ids.certActiveProfile, null, "Alana Kealoha", "certifier", "active"],
			[ids.certRevokedProfile, null, "Rex Revoked", "certifier", "active"],
			[ids.certBlockedProfile, null, "Blake Blocked", "certifier", "active"],
			[ids.certOtherWpProfile, null, "Oren Other", "certifier", "active"],
		];

		for (const [id, wp, name, role, status] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, $3, $4::global_role, $5::active_blocked)`,
				[id, wp, name, role, status],
			);
		}

		// Four testers covering every combination the reminder has to filter on.
		const certifiers: [string, string, string, string, string][] = [
			[
				certifierIds.active,
				ids.certActiveProfile,
				"Island Backflow",
				"HI-1",
				"active",
			],
			[
				certifierIds.revoked,
				ids.certRevokedProfile,
				"Revoked Testing",
				"HI-2",
				"active",
			],
			[
				certifierIds.blocked,
				ids.certBlockedProfile,
				"Blocked Testing",
				"HI-3",
				"blocked",
			],
			[
				certifierIds.otherWp,
				ids.certOtherWpProfile,
				"Other WP Testing",
				"HI-4",
				"active",
			],
		];

		for (const [id, profileId, company, idNumber, status] of certifiers) {
			await pool.query(
				`insert into certifiers (id, profile_id, company, id_number, status)
				 values ($1, $2, $3, $4, $5::active_blocked)`,
				[id, profileId, company, idNumber, status],
			);
		}

		await pool.query(
			`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
			 values ($1, $2, 'active'),
			        ($3, $2, 'revoked'),
			        ($4, $2, 'active'),
			        ($5, $6, 'active')`,
			[
				certifierIds.active,
				wpA,
				certifierIds.revoked,
				certifierIds.blocked,
				certifierIds.otherWp,
				wpB,
			],
		);

		// wpA has the paid add-on switched on. wpB has no row at all, which is
		// how every new purveyor starts and must be read as off.
		await pool.query(
			`insert into wp_feature_flags (water_purveyor_id, feature, is_enabled)
			 values ($1, 'automated_notices', true)`,
			[wpA],
		);

		const customers: [string, string, string, string, string][] = [
			[
				customerIds.primary,
				wpA,
				"Marta Ellison",
				"wf1-marta@example.com",
				"active",
			],
			[
				customerIds.replacement,
				wpA,
				"Tomas Reyes",
				"wf1-tomas@example.com",
				"active",
			],
			[
				customerIds.suspended,
				wpA,
				"Halted Holdings",
				"wf1-halted@example.com",
				"suspended",
			],
			[
				customerIds.markup,
				wpA,
				"Ampersand & <script>Co</script>",
				"wf1-markup@example.com",
				"active",
			],
			[
				customerIds.foreign,
				wpB,
				"Marta Ellison",
				"wf1-foreign@example.com",
				"active",
			],
		];

		for (const [id, wp, name, email, status] of customers) {
			await pool.query(
				`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
				 values ($1, $2, $3, $4, 'standard', $5::customer_status)`,
				[id, wp, name, email, status],
			);
		}

		// wpA customized its reminder and nothing else, so one suite covers both
		// the purveyor's own text and the platform fallback.
		await pool.query(
			`insert into notice_templates (water_purveyor_id, notice_type, subject, body)
			 values ($1, 'reminder', $2, $3)`,
			[wpA, CUSTOM_REMINDER_SUBJECT, CUSTOM_REMINDER_BODY],
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();

		// Whatever a test left queued is withdrawn, so the next test's tick or
		// claim sees only its own work.
		await pool.query(
			`update scheduled_jobs set status = 'cancelled'
			  where status in ('pending', 'running') and water_purveyor_id = any($1::uuid[])`,
			[[wpA, wpB]],
		);
	});

	afterAll(async () => {
		if (!pool) return;

		const wps = [[wpA, wpB]];

		await pool.query(
			"delete from scheduled_jobs where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from test_submissions where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			`delete from customer_assignments
			  where bfa_asset_id in (select id from bfa_assets where water_purveyor_id = any($1::uuid[]))`,
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
			"delete from notice_templates where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from wp_feature_flags where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from wp_certifier_authorizations where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query("delete from certifiers where id = any($1::uuid[])", [
			Object.values(certifierIds),
		]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB],
		]);
		await pool.end();
	});

	describe("scheduling and reconciliation", () => {
		it("puts a newly registered asset on the reminder schedule, two calendar months ahead of the due date", async () => {
			const lines = captureLogs();
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);

			const rows = await jobsFor(asset.id);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.job_type).toBe("reminder");
			expect(rows[0]?.status).toBe("pending");
			expect(rows[0]?.run_at.toISOString()).toBe(
				noticeRunAt(futureDate, "reminder").toISOString(),
			);
			// Midnight in Honolulu on the day two calendar months before the test.
			expect(rows[0]?.run_at.toISOString()).toBe(
				honoluluDayStart(addCalendarMonths(futureDate, -2)).toISOString(),
			);

			const scheduled = eventsNamed(lines, "scheduler_job_scheduled");
			expect(scheduled).toHaveLength(1);
			expect(scheduled[0]).toMatchObject({
				job_type: "reminder",
				asset_id: asset.id,
				wp_id: wpA,
				// The purveyor's own save caused it, so the line names them.
				actor_id: ids.adminA,
				trigger: "asset_created",
			});
		});

		it("schedules the reminder for a past-due asset too, so the escalation can catch up", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ annualTestDate: longOverdueDate }),
			);

			const rows = await jobsFor(asset.id);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.run_at.getTime()).toBeLessThan(Date.now());
		});

		it("does not pre-create the rest of the chain", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(newAsset());

			const rows = await jobsFor(asset.id);

			expect(rows.map((row) => row.job_type)).toEqual(["reminder"]);
		});

		it("moves the reminder when the annual test date is corrected, without leaving a second one", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);
			const corrected = addCalendarDays(futureDate, 20);

			const lines = captureLogs();
			await caller.assets.updateAsset(
				asUpdate(asset, { annualTestDate: corrected }),
			);

			const rows = await jobsFor(asset.id);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("pending");
			expect(rows[0]?.run_at.toISOString()).toBe(
				noticeRunAt(corrected, "reminder").toISOString(),
			);
			expect(eventsNamed(lines, "scheduler_job_rescheduled")).toHaveLength(1);
		});

		it("cancels an obsolete late notice and reschedules from the new date", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			// Fire the reminder so the asset is genuinely mid-chain.
			await runStage(asset.id);
			const midChain = await liveJobFor(asset.id);
			expect(midChain.job_type).toBe("late_notice_1");

			await caller.assets.updateAsset(
				asUpdate(asset, { annualTestDate: futureDate }),
			);

			const rows = await jobsFor(asset.id);
			const byType = new Map(rows.map((row) => [row.job_type, row]));

			expect(byType.get("late_notice_1")?.status).toBe("cancelled");
			expect(byType.get("late_notice_1")?.last_error).toMatch(
				/annual test date changed/i,
			);
			// A fresh reminder, because the previous one already completed.
			const reminders = rows.filter((row) => row.job_type === "reminder");
			expect(reminders.map((row) => row.status).sort()).toEqual([
				"completed",
				"pending",
			]);
			expect(
				reminders.find((row) => row.status === "pending")?.run_at.toISOString(),
			).toBe(noticeRunAt(futureDate, "reminder").toISOString());
		});

		it("writes nothing to the schedule when a save does not touch the date", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);
			const before = await jobsFor(asset.id);

			const lines = captureLogs();
			await caller.assets.updateAsset(
				asUpdate(asset, { serviceAddress: "99 Another Road" }),
			);

			const after = await jobsFor(asset.id);

			expect(after).toEqual(before);
			expect(eventsNamed(lines, "scheduler_job_rescheduled")).toHaveLength(0);
			expect(eventsNamed(lines, "scheduler_job_scheduled")).toHaveLength(0);
		});

		it("re-reconciling the same date writes nothing and logs nothing", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);
			const before = await jobsFor(asset.id);

			const lines = captureLogs();
			await reconcileAssetNoticeChain({
				assetId: asset.id,
				waterPurveyorId: wpA,
				annualTestDate: futureDate,
				trigger: "annual_test_date_changed",
			});

			expect(await jobsFor(asset.id)).toEqual(before);
			expect(eventsNamed(lines, "scheduler_job_rescheduled")).toHaveLength(0);
		});

		it("withdraws the chain for an asset with no annual test date", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);

			// The mutations both require a date, so this state is only reachable
			// for a row written outside them — a seed, an import, a restore.
			const lines = captureLogs();
			await reconcileAssetNoticeChain({
				assetId: asset.id,
				waterPurveyorId: wpA,
				annualTestDate: null,
				trigger: "annual_test_date_changed",
			});

			const rows = await jobsFor(asset.id);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("cancelled");
			expect(eventsNamed(lines, "scheduler_job_cancelled")).toHaveLength(1);
		});
	});

	describe("the feature flag is checked when the job runs", () => {
		it("cancels the job for a purveyor with no flag row, and sends nothing", async () => {
			const asset = await callerFor(ids.adminB).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.foreign }),
			);

			const lines = captureLogs();
			const { outcome } = await runStage(asset.id);

			expect(outcome).toMatchObject({ kind: "cancelled" });
			expect(deliveries(lines)).toHaveLength(0);

			const rows = await jobsFor(asset.id);
			expect(rows[0]?.status).toBe("cancelled");
			expect(rows[0]?.last_error).toMatch(/switched off/i);
			// Cancelled, not failed: switching off a paid add-on is not a delivery
			// problem and must not be retried as one.
			expect(rows[0]?.attempts).toBe(0);
			expect(rows.filter((row) => row.job_type === "late_notice_1")).toEqual(
				[],
			);
		});

		it("cancels the job when the flag exists and is off", async () => {
			await pool.query(
				`insert into wp_feature_flags (water_purveyor_id, feature, is_enabled)
				 values ($1, 'automated_notices', false)`,
				[wpB],
			);

			try {
				const asset = await callerFor(ids.adminB).assets.createAsset(
					newAsset({ currentCustomerId: customerIds.foreign }),
				);

				const lines = captureLogs();
				const { outcome } = await runStage(asset.id);

				expect(outcome).toMatchObject({ kind: "cancelled" });
				expect(deliveries(lines)).toHaveLength(0);
			} finally {
				await pool.query(
					`delete from wp_feature_flags
					  where water_purveyor_id = $1 and feature = 'automated_notices'`,
					[wpB],
				);
			}
		});
	});

	describe("who the notice is addressed to", () => {
		it("writes to the asset's current customer", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			const lines = captureLogs();
			await runStage(asset.id);

			const sent = deliveries(lines);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.to).toBe("wf1-marta@example.com");
		});

		it("follows a reassignment rather than a customer id remembered at queue time", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			await caller.assets.assignCustomer({
				assetId: asset.id,
				customerId: customerIds.replacement,
			});

			const lines = captureLogs();
			await runStage(asset.id);

			const sent = deliveries(lines);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.to).toBe("wf1-tomas@example.com");
			expect(deliveries(lines, "wf1-marta@example.com")).toHaveLength(0);
		});

		it("sends nothing when the asset points at a customer in another purveyor", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(newAsset());

			// `assignCustomer` refuses a cross-tenant id, so this row is written
			// directly — a restore or a corrupted row is the case that matters, and
			// a notice is the one place it would be mailed to the wrong company's
			// customer.
			await pool.query(
				"update bfa_assets set current_customer_id = $1 where id = $2",
				[customerIds.foreign, asset.id],
			);

			const lines = captureLogs();
			const { outcome } = await runStage(asset.id);

			expect(outcome).toMatchObject({ kind: "held" });
			expect(deliveries(lines)).toHaveLength(0);
		});
	});

	describe("a suspended or missing customer holds the whole pipeline", () => {
		it("holds, sends nothing, and does not advance the chain when no customer is attached", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(newAsset());

			const lines = captureLogs();
			const { outcome } = await runStage(asset.id);

			expect(outcome).toMatchObject({ kind: "held" });
			expect(deliveries(lines)).toHaveLength(0);

			const rows = await jobsFor(asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.job_type).toBe("reminder");
			expect(rows[0]?.status).toBe("pending");
			expect(rows[0]?.last_error).toMatch(/nobody to write to/i);
			// A hold is not a failure, so no attempt is consumed.
			expect(rows[0]?.attempts).toBe(0);
			expect(rows[0]?.sent_at).toBeNull();
		});

		it("holds for a suspended customer", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.suspended }),
			);

			const lines = captureLogs();
			const { outcome } = await runStage(asset.id);

			expect(outcome).toMatchObject({ kind: "held" });
			expect(deliveries(lines)).toHaveLength(0);

			const held = await liveJobFor(asset.id);
			expect(held.job_type).toBe("reminder");
			expect(held.last_error).toMatch(/suspended/i);
			expect(eventsNamed(lines, "scheduler_job_held")).toHaveLength(1);
		});

		it("resumes the waiting stage — and only that stage — once an active customer is attached", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			// Stage one goes out to the original occupant, then they are replaced by
			// a suspended customer and stage two holds.
			await runStage(asset.id);
			await caller.assets.assignCustomer({
				assetId: asset.id,
				customerId: customerIds.suspended,
				acknowledgeSuspendedCustomer: true,
			});
			const firstHold = await runStage(asset.id);
			expect(firstHold.outcome).toMatchObject({ kind: "held" });
			expect(firstHold.job.jobType).toBe("late_notice_1");

			const heldBefore = await liveJobFor(asset.id);
			expect(heldBefore.run_at.getTime()).toBeGreaterThan(Date.now());

			const lines = captureLogs();
			await caller.assets.assignCustomer({
				assetId: asset.id,
				customerId: customerIds.replacement,
			});

			const resumed = await liveJobFor(asset.id);

			// The stage that was waiting is due again immediately. Nothing already
			// sent is replayed: the reminder stays `completed`.
			expect(resumed.job_type).toBe("late_notice_1");
			expect(resumed.run_at.getTime()).toBeLessThanOrEqual(Date.now());
			expect(eventsNamed(lines, "scheduler_job_resumed")).toHaveLength(1);

			const rows = await jobsFor(asset.id);
			expect(
				rows.filter((row) => row.job_type === "reminder").map((r) => r.status),
			).toEqual(["completed"]);

			// And it now sends, to the new occupant.
			const sendLines = captureLogs();
			const { outcome } = await runStage(asset.id);
			expect(outcome).toMatchObject({ kind: "sent" });
			expect(deliveries(sendLines)).toHaveLength(1);
			expect(deliveries(sendLines)[0]?.to).toBe("wf1-tomas@example.com");
		});

		it("does not resume for a suspended customer", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(newAsset());

			await runStage(asset.id);
			const before = await liveJobFor(asset.id);

			await caller.assets.assignCustomer({
				assetId: asset.id,
				customerId: customerIds.suspended,
				acknowledgeSuspendedCustomer: true,
			});

			const after = await liveJobFor(asset.id);
			expect(after.run_at.toISOString()).toBe(before.run_at.toISOString());
		});

		it("does not pull a stage that is not yet due", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);
			const before = await liveJobFor(asset.id);

			await caller.assets.assignCustomer({
				assetId: asset.id,
				customerId: customerIds.primary,
			});

			const after = await liveJobFor(asset.id);
			expect(after.run_at.toISOString()).toBe(before.run_at.toISOString());
		});
	});

	describe("the reminder's certifier list", () => {
		it("lists only certifiers who are both authorized here and active on the platform", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			const lines = captureLogs();
			await runStage(asset.id);

			const html = String(deliveries(lines)[0]?.html);

			expect(html).toContain(CERTIFIER_LIST_HEADING);
			expect(html).toContain("Alana Kealoha");
			// Authorization revoked by this purveyor.
			expect(html).not.toContain("Rex Revoked");
			// Blocked on the platform, so authorized here but unable to work.
			expect(html).not.toContain("Blake Blocked");
			// Another purveyor's tester.
			expect(html).not.toContain("Oren Other");
		});

		it("reflects an authorization revoked after the job was scheduled", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			await pool.query(
				`update wp_certifier_authorizations set authorization_status = 'revoked'
				  where certifier_id = $1 and water_purveyor_id = $2`,
				[certifierIds.active, wpA],
			);

			try {
				const lines = captureLogs();
				await runStage(asset.id);

				const html = String(deliveries(lines)[0]?.html);

				expect(html).not.toContain("Alana Kealoha");
				// Nobody to list, so no empty heading either.
				expect(html).not.toContain(CERTIFIER_LIST_HEADING);
			} finally {
				await pool.query(
					`update wp_certifier_authorizations set authorization_status = 'active'
					  where certifier_id = $1 and water_purveyor_id = $2`,
					[certifierIds.active, wpA],
				);
			}
		});

		it("does not put the list on a late notice", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			await runStage(asset.id);

			const lines = captureLogs();
			const { job } = await runStage(asset.id);

			expect(job.jobType).toBe("late_notice_1");
			expect(String(deliveries(lines)[0]?.html)).not.toContain(
				CERTIFIER_LIST_HEADING,
			);
		});
	});

	describe("the text that is sent", () => {
		it("uses the purveyor's own template and substitutes the asset's values", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({
					currentCustomerId: customerIds.primary,
					serviceAddress: "7 Reef Lane",
					bfaType: "PVB",
				}),
			);

			const lines = captureLogs();
			await runStage(asset.id);

			const sent = deliveries(lines)[0];
			const html = String(sent?.html);

			expect(sent?.subject).toBe(`Test due ${longOverdueDate} at 7 Reef Lane`);
			expect(html).toContain("Aloha Marta Ellison,");
			expect(html).toContain(`Your PVB assembly, BIN ${asset.bin}`);
			expect(html).toContain(longOverdueDate);
			expect(html).toContain("Kalani Water Works");
			// Nothing left unresolved.
			expect(html).not.toContain("{{");

			const completed = eventsNamed(lines, "scheduler_job_completed")[0];
			expect(completed).toMatchObject({ template_source: "purveyor" });
		});

		it("falls back to the platform default for a type the purveyor never wrote", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			await runStage(asset.id);

			const lines = captureLogs();
			await runStage(asset.id);

			const sent = deliveries(lines)[0];
			expect(sent?.subject).toBe(
				PLATFORM_DEFAULT_NOTICE_TEMPLATES.late_notice_1.subject.replace(
					"{{service_address}}",
					"12 Kalani Street",
				),
			);
			expect(eventsNamed(lines, "scheduler_job_completed")[0]).toMatchObject({
				template_source: "platform",
			});
		});

		it("escapes substituted values and goes through the shared email layout", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.markup }),
			);

			const lines = captureLogs();
			await runStage(asset.id);

			const html = String(deliveries(lines)[0]?.html);

			// `renderTextEmail` → `templateToHtml` escapes, and only line breaks
			// become markup. A customer name containing a tag is text, not an
			// element.
			expect(html).toContain("Ampersand &amp; &lt;script&gt;Co&lt;/script&gt;");
			expect(html).not.toContain("<script>");
			// The one shared shell, not a second layout.
			expect(html).toContain("Backflow Assembly Platform");
			expect(html).toContain("<!DOCTYPE html>");
		});
	});

	describe("the escalation", () => {
		it("schedules only the immediate successor at each stage, and stops after the final notice", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			const expected: NoticeType[] = [
				"reminder",
				"late_notice_1",
				"late_notice_2",
				"final_notice",
			];
			const sentStages: string[] = [];

			for (const stage of expected) {
				const lines = captureLogs();
				const { job, outcome } = await runStage(asset.id);

				expect(job.jobType).toBe(stage);
				expect(outcome).toMatchObject({ kind: "sent" });
				expect(deliveries(lines, "wf1-marta@example.com")).toHaveLength(1);
				sentStages.push(stage);

				const rows = await jobsFor(asset.id);
				const live = rows.filter(
					(row) => row.status === "pending" || row.status === "running",
				);

				if (stage === "final_notice") {
					// Nothing follows the final notice.
					expect(live).toHaveLength(0);
				} else {
					expect(live).toHaveLength(1);
					expect(live[0]?.run_at.toISOString()).toBe(
						noticeRunAt(
							longOverdueDate,
							live[0]?.job_type as NoticeType,
						).toISOString(),
					);
				}

				// Never more than one stage ahead.
				expect(rows).toHaveLength(
					sentStages.length + (stage === "final_notice" ? 0 : 1),
				);
				vi.restoreAllMocks();
			}

			const rows = await jobsFor(asset.id);
			expect(rows.map((row) => row.job_type)).toEqual(expected);
			expect(rows.every((row) => row.status === "completed")).toBe(true);
		});

		it("records each stage's due day in Hawaii", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({
					currentCustomerId: customerIds.primary,
					annualTestDate: longOverdueDate,
				}),
			);

			const dueDays = [
				addCalendarMonths(longOverdueDate, -2),
				addCalendarDays(longOverdueDate, 1),
				addCalendarDays(longOverdueDate, 32),
				addCalendarDays(longOverdueDate, 63),
			];

			for (const dueDay of dueDays) {
				const live = await liveJobFor(asset.id);
				expect(live.run_at.toISOString()).toBe(
					honoluluDayStart(dueDay).toISOString(),
				);

				if (dueDay === dueDays[dueDays.length - 1]) break;

				await runStage(asset.id);
			}
		});
	});

	describe("a passing test ends the chain", () => {
		/** A submitted test for this asset, at the given status and result. */
		async function seedSubmission(
			assetId: string | null,
			{
				status,
				result,
				waterPurveyorId = wpA,
			}: {
				status: "draft" | "submitted";
				result: "pass" | "fail";
				waterPurveyorId?: string;
			},
		) {
			const id = randomUUID();

			await pool.query(
				`insert into test_submissions
				   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
				    wizard_data, test_date, test_result, signature_method)
				 values ($1, $2, $3, $4, $5::submission_status, 'RP', '{}'::jsonb,
				         current_date, $6::test_result, 'signed')`,
				[id, assetId, certifierIds.active, waterPurveyorId, status, result],
			);

			return id;
		}

		it("cancels every remaining stage when a submitted passing test is corrected", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);

			await runStage(asset.id);
			expect((await liveJobFor(asset.id)).job_type).toBe("late_notice_1");

			const submissionId = await seedSubmission(asset.id, {
				status: "submitted",
				result: "pass",
			});

			const lines = captureLogs();
			await caller.submittedTests.updateSubmittedTest({
				id: submissionId,
				bfaType: "RP",
				submittedBinText: "corrected-bin-text",
				testDate: honoluluToday(),
				testResult: "pass",
				signatureMethod: "signed",
				signatureData: null,
				wizardData: {},
			});

			const rows = await jobsFor(asset.id);
			const byType = new Map(rows.map((row) => [row.job_type, row]));

			expect(byType.get("late_notice_1")?.status).toBe("cancelled");
			expect(byType.get("late_notice_1")?.last_error).toMatch(/passing test/i);
			expect(rows.filter((row) => row.status === "pending")).toEqual([]);

			const cancelled = eventsNamed(lines, "scheduler_job_cancelled");
			expect(cancelled).toHaveLength(1);
			expect(cancelled[0]).toMatchObject({
				trigger: "passing_test_submitted",
				submission_id: submissionId,
				asset_id: asset.id,
			});
		});

		it("leaves the chain alone for a failed test", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const submissionId = await seedSubmission(asset.id, {
				status: "submitted",
				result: "fail",
			});

			await caller.submittedTests.updateSubmittedTest({
				id: submissionId,
				bfaType: "RP",
				submittedBinText: "changed",
				testDate: honoluluToday(),
				testResult: "fail",
				signatureMethod: "signed",
				signatureData: null,
				wizardData: {},
			});

			const live = await liveJobFor(asset.id);
			expect(live.job_type).toBe("reminder");
			expect(live.status).toBe("pending");
		});

		it("leaves the chain alone for a passing draft, which this router cannot even read", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const submissionId = await seedSubmission(asset.id, {
				status: "draft",
				result: "pass",
			});

			// Every query in the submitted-tests router pins `status = 'submitted'`,
			// so a draft is not merely unlisted — it names no row at all.
			await expect(
				caller.submittedTests.updateSubmittedTest({
					id: submissionId,
					bfaType: "RP",
					submittedBinText: "changed",
					testDate: honoluluToday(),
					testResult: "pass",
					signatureMethod: "signed",
					signatureData: null,
					wizardData: {},
				}),
			).rejects.toThrow(/not found/i);

			const live = await liveJobFor(asset.id);
			expect(live.job_type).toBe("reminder");
		});

		it("cancels the chain when a passing test is linked to the assembly", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const submissionId = await seedSubmission(null, {
				status: "submitted",
				result: "pass",
			});

			await caller.submittedTests.linkSubmissionAsset({
				submissionId,
				assetId: asset.id,
			});

			const rows = await jobsFor(asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("cancelled");
			expect(rows[0]?.last_error).toMatch(/passing test/i);
		});

		it("does not cancel the chain when a failed test is linked", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const submissionId = await seedSubmission(null, {
				status: "submitted",
				result: "fail",
			});

			await caller.submittedTests.linkSubmissionAsset({
				submissionId,
				assetId: asset.id,
			});

			expect((await liveJobFor(asset.id)).status).toBe("pending");
		});

		it("does not send the successor for a job cancelled while it was running", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await caller.assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			const [claimed] = await db
				.update(scheduledJobs)
				.set({ status: "running" })
				.where(eq(scheduledJobs.id, live.id))
				.returning();

			// The passing test lands while the handler holds the row.
			const submissionId = await seedSubmission(null, {
				status: "submitted",
				result: "pass",
			});
			await caller.submittedTests.linkSubmissionAsset({
				submissionId,
				assetId: asset.id,
			});

			const lines = captureLogs();
			const outcome = await runNoticeJob(claimed as ScheduledJob, "reminder");

			expect(outcome).toMatchObject({ kind: "superseded" });
			expect(eventsNamed(lines, "scheduler_job_superseded")).toHaveLength(1);

			const rows = await jobsFor(asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("cancelled");
			// The cancellation won; no late notice was queued behind it.
			expect(rows.filter((row) => row.job_type === "late_notice_1")).toEqual(
				[],
			);
		});
	});

	describe("retries, recovery, concurrency and idempotency", () => {
		/**
		 * Makes every send fail the way a refused provider call does.
		 *
		 * `resolveEmailDriver` throws on an unknown `EMAIL_DRIVER`, and it is
		 * evaluated inside `sendEmail`, so this produces a real thrown delivery
		 * failure through the real code path rather than a mocked module.
		 */
		/** An instant far enough ahead that a row claimed now reads as abandoned. */
		function afterStaleWindow() {
			return new Date(Date.now() + STALE_RUNNING_AFTER_MS + 60_000);
		}

		async function withBrokenDelivery<T>(fn: () => Promise<T>): Promise<T> {
			const previous = process.env.EMAIL_DRIVER;
			process.env.EMAIL_DRIVER = "wf1-broken-driver";

			try {
				return await fn();
			} finally {
				if (previous === undefined) delete process.env.EMAIL_DRIVER;
				else process.env.EMAIL_DRIVER = previous;
			}
		}

		it("retries a refused delivery with a backoff, and releases the send claim", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			const lines = captureLogs();
			await withBrokenDelivery(() => runSchedulerTick({ limit: 50 }));

			const [row] = (await jobsFor(asset.id)).filter(
				(candidate) => candidate.id === live.id,
			);

			expect(row?.status).toBe("pending");
			expect(row?.attempts).toBe(1);
			expect(row?.last_error).toMatch(/EMAIL_DRIVER/i);
			// The claim is given back, because nothing was accepted — otherwise the
			// retry would skip the send forever.
			expect(row?.sent_at).toBeNull();
			expect(row?.run_at.getTime()).toBeGreaterThan(Date.now());

			const retrying = eventsNamed(lines, "scheduler_job_retrying").filter(
				(line) => line.job_id === live.id,
			);
			expect(retrying).toHaveLength(1);
			expect(retrying[0]).toMatchObject({ attempts: 1 });
		});

		it("gives up after the attempt ceiling and does not escalate to the next stage", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			captureLogs();

			await withBrokenDelivery(async () => {
				for (let attempt = 0; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
					// The backoff put the row in the future; a real deployment waits,
					// a test does not.
					await pool.query(
						"update scheduled_jobs set run_at = now() - interval '1 minute' where id = $1",
						[live.id],
					);
					await runSchedulerTick({ limit: 50 });
				}
			});

			const rows = await jobsFor(asset.id);
			const failed = rows.find((row) => row.id === live.id);

			expect(failed?.status).toBe("failed");
			expect(failed?.attempts).toBe(MAX_JOB_ATTEMPTS);
			expect(failed?.completed_at).not.toBeNull();
			// The chain stops at the failure rather than escalating past a notice
			// the customer never received.
			expect(rows).toHaveLength(1);
		});

		it("reclaims a job a crashed process left running, and counts the crash as an attempt", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			// A row claimed and never finished: the shape a killed process leaves
			// behind.
			await pool.query(
				"update scheduled_jobs set status = 'running' where id = $1",
				[live.id],
			);

			const lines = captureLogs();
			// The clock is advanced rather than `updated_at` backdated, because the
			// table's `set_updated_at` trigger rewrites that column on any UPDATE —
			// which is exactly why staleness can be read off it in production
			// without a second lease column to keep in step.
			const recovery = await recoverInterruptedJobs({
				now: afterStaleWindow(),
			});

			expect(recovery.recovered).toBeGreaterThanOrEqual(1);

			const [row] = (await jobsFor(asset.id)).filter((r) => r.id === live.id);
			expect(row?.status).toBe("pending");
			expect(row?.attempts).toBe(1);
			expect(row?.last_error).toMatch(/stopped before it finished/i);
			expect(
				eventsNamed(lines, "scheduler_job_recovered").filter(
					(line) => line.job_id === live.id,
				),
			).toHaveLength(1);
		});

		it("does not resend a notice whose send was already claimed before the crash", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			// The state a process dies in after `sent_at` was written: the mail may
			// already be out, so the retry must not send a second copy.
			await pool.query(
				`update scheduled_jobs
				    set status = 'running', sent_at = now()
				  where id = $1`,
				[live.id],
			);

			await recoverInterruptedJobs({ now: afterStaleWindow() });

			const lines = captureLogs();
			const { outcome } = await runStage(asset.id);

			expect(outcome).toMatchObject({ kind: "sent" });
			// No second copy…
			expect(deliveries(lines)).toHaveLength(0);
			// …and the chain still advances, so the customer is not dropped out of
			// the escalation by a crash.
			expect(eventsNamed(lines, "scheduler_job_completed")[0]).toMatchObject({
				mail_sent: false,
			});
			expect((await liveJobFor(asset.id)).job_type).toBe("late_notice_1");
		});

		it("lets only one of two simultaneous claims take a due job", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			const [first, second] = await Promise.all([
				claimDueJobs({ now: new Date(), limit: 50 }),
				claimDueJobs({ now: new Date(), limit: 50 }),
			]);

			const claimedBy = [first, second].map((batch) =>
				batch.some((job) => job.id === live.id),
			);

			expect(claimedBy.filter(Boolean)).toHaveLength(1);
		});

		it("sends exactly one email when two handlers run the same claimed job", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ currentCustomerId: customerIds.primary }),
			);
			const live = await liveJobFor(asset.id);

			const [claimed] = await db
				.update(scheduledJobs)
				.set({ status: "running" })
				.where(eq(scheduledJobs.id, live.id))
				.returning();

			const job = claimed as ScheduledJob;

			const lines = captureLogs();
			const outcomes = await Promise.all([
				runNoticeJob(job, "reminder"),
				runNoticeJob(job, "reminder"),
			]);

			// `sent_at` is claimed with a conditional update, so only one pass owns
			// the send however many run it.
			expect(deliveries(lines, "wf1-marta@example.com")).toHaveLength(1);
			// One completes the row; the other finds it no longer `running`.
			expect(outcomes.filter((o) => o.kind === "sent")).toHaveLength(1);
			expect(outcomes.filter((o) => o.kind === "superseded")).toHaveLength(1);

			// And exactly one successor, not two.
			const rows = await jobsFor(asset.id);
			expect(
				rows.filter((row) => row.job_type === "late_notice_1"),
			).toHaveLength(1);
		});

		it("refuses a second live job for the same stage", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ annualTestDate: futureDate }),
			);

			// The partial unique index from 0012 is what makes two clerks saving a
			// date change at the same instant produce one reminder rather than two.
			await expect(
				pool.query(
					`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
					 values ('reminder', $1, $2, now(), 'pending')`,
					[asset.id, wpA],
				),
			).rejects.toThrow(/scheduled_jobs_live_asset_job_type_key/);
		});
	});

	describe("asset_status is recomputed from the annual test date", () => {
		it("derives all three values, and writes nothing on a second pass", async () => {
			const caller = callerFor(ids.adminA);

			const pastDue = await caller.assets.createAsset(
				newAsset({ annualTestDate: addCalendarDays(today, -1) }),
			);
			const dueSoon = await caller.assets.createAsset(
				newAsset({ annualTestDate: addCalendarDays(today, 10) }),
			);
			const active = await caller.assets.createAsset(
				newAsset({ annualTestDate: addCalendarMonths(today, 6) }),
			);

			await recomputeAssetStatuses();

			const { rows } = await pool.query<{ id: string; asset_status: string }>(
				"select id, asset_status from bfa_assets where id = any($1::uuid[])",
				[[pastDue.id, dueSoon.id, active.id]],
			);
			const statusOf = new Map(rows.map((row) => [row.id, row.asset_status]));

			expect(statusOf.get(pastDue.id)).toBe("past_due");
			expect(statusOf.get(dueSoon.id)).toBe("due_soon");
			expect(statusOf.get(active.id)).toBe("active");

			// Idempotent: the second pass finds nothing to correct, so it moves no
			// `updated_at` and emits no line.
			const lines = captureLogs();
			const changed = await recomputeAssetStatuses();

			expect(changed).toBe(0);
			expect(
				eventsNamed(lines, "scheduler_asset_status_recomputed"),
			).toHaveLength(0);
		});

		it("treats the due date itself as due_soon, not past due", async () => {
			const asset = await callerFor(ids.adminA).assets.createAsset(
				newAsset({ annualTestDate: today }),
			);

			await recomputeAssetStatuses();

			const { rows } = await pool.query<{ asset_status: string }>(
				"select asset_status from bfa_assets where id = $1",
				[asset.id],
			);

			expect(rows[0]?.asset_status).toBe("due_soon");
		});
	});
});
