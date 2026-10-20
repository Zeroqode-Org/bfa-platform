import { randomUUID } from "node:crypto";

import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import type { inferProcedureInput } from "@trpc/server";
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
import type { EmailDriver } from "../lib/email";
import type { AppRouter } from "../routers/index";

/**
 * Workflow 3 — the failure notice and the fail list — against real Postgres.
 *
 * The same reasoning as the Workflow 1 suite: what this feature promises is a
 * set of conditional writes (a job queued exactly once per submitted fail, a
 * payload frozen once, a completion that refuses a cancelled row) and reads
 * resolved *at send time* (the current customer, the currently active repair
 * companies, whether a later pass has resolved the failure), plus a membership
 * query computed from history. None of that is observable through a mocked
 * database.
 *
 * Two clocks are under test and they are deliberately different: the failure
 * email is queued the moment a failed test is submitted, while the fail list
 * shows an asset only once that failure has gone 30 days without a later
 * submitted pass (PRD § 6.8). The list's boundary is asserted against
 * `listFailingAssets` with an explicit `now`, so "29 days", "one millisecond
 * short of 30" and "exactly 30" are exact rather than racing the wall clock;
 * one test goes through `dashboard.failList` itself to prove the procedure
 * applies the same rule to the real clock.
 *
 * **A re-test is a new submitted record.** Workflow scenarios go through
 * `submitTest`, which inserts a new submitted row and then runs
 * `applySubmittedTestResult` for it — exactly what the wizard's submit will
 * do. No scenario edits an earlier submission's result to stand in for a
 * re-test. The WP correction feature, which *does* rewrite a submitted row by
 * design, has its own section and is exercised only as a correction.
 *
 * Two purveyors are seeded with interchangeable data so a leak looks like a
 * leak. Deliberately, **neither has any `wp_feature_flags` row**: the failure
 * notice is not gated on `automated_notices`, and every email this suite sees
 * delivered is proof of that.
 *
 * Opt-in: writes real rows; runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

let db: typeof import("@bfa-platform/db")["db"];
let runFailureNoticeJob: typeof import("./failure-notice")["runFailureNoticeJob"];
let runSchedulerTick: typeof import("./index")["runSchedulerTick"];
let applySubmittedTestResult: typeof import("./submission-lifecycle")["applySubmittedTestResult"];
let listFailingAssets: typeof import("../routers/dashboard")["listFailingAssets"];

type SubmittedTests = AppRouter["submittedTests"];
type UpdateInput = inferProcedureInput<SubmittedTests["updateSubmittedTest"]>;

const wpA = randomUUID();
const wpB = randomUUID();

const ids = {
	adminA: randomUUID(),
	adminB: randomUUID(),
	certProfile: randomUUID(),
};

const certifierId = randomUUID();

const customerIds = {
	/** Active, in wpA, with markup in the name — proves the body is escaped. */
	primary: randomUUID(),
	/** Active, in wpA. Used to prove routing follows a reassignment. */
	replacement: randomUUID(),
	/** Suspended, in wpA. Holds the notice. */
	suspended: randomUUID(),
	/** Active, in wpA, no email address. Holds the notice. */
	noEmail: randomUUID(),
	/** Active, in wpB. Must never receive wpA's mail. */
	foreign: randomUUID(),
};

const repairIds = {
	/** Active in wpA, with phone AND an email that must never be rendered. */
	activeFull: randomUUID(),
	/** Active in wpA, no phone, markup in the name — proves escaping. */
	activeBare: randomUUID(),
	/** Inactive in wpA. Must not appear. */
	inactive: randomUUID(),
	/** Active in wpB. Must not appear in wpA's mail. */
	foreign: randomUUID(),
};

const REPAIR_EMAIL = "wf3-repair-secret@example.com";

let pool: pg.Pool;
let binCounter = 0;

let callerFor: (profileId: string) => {
	assets: {
		updateAsset: (
			input: inferProcedureInput<AppRouter["assets"]["updateAsset"]>,
		) => Promise<unknown>;
	};
	submittedTests: {
		updateSubmittedTest: (input: UpdateInput) => Promise<unknown>;
		linkSubmissionAsset: (
			input: inferProcedureInput<SubmittedTests["linkSubmissionAsset"]>,
		) => Promise<unknown>;
	};
	dashboard: {
		failList: () => Promise<
			{
				id: string;
				bin: string;
				bfaType: string;
				serviceAddress: string;
				currentCustomerName: string | null;
				failingSince: string;
			}[]
		>;
	};
};

/** Collects the structured JSON lines the code under test emits. */
function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		try {
			lines.push(JSON.parse(String(value)));
		} catch {
			// Not one of ours.
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

/** An asset in the given purveyor, inserted directly — no reminder chain. */
async function seedAsset({
	waterPurveyorId = wpA,
	currentCustomerId = null as string | null,
	// `null` for a no-BIN asset, as the wizard registers one at submit.
	bin: binOverride = undefined as string | null | undefined,
} = {}) {
	binCounter += 1;
	const id = randomUUID();
	const bin =
		binOverride === undefined
			? `WF3-${binCounter}-${randomUUID().slice(0, 6)}`
			: binOverride;

	await pool.query(
		`insert into bfa_assets (id, water_purveyor_id, bin, current_customer_id, bfa_type, service_address)
		 values ($1, $2, $3, $4, 'RP', '12 Kalani Street')`,
		[id, waterPurveyorId, bin, currentCustomerId],
	);

	return { id, bin };
}

/**
 * A test submission at an exact point in event time. `createdAt` is explicit
 * because the fail list and the resolution check both order by
 * `(created_at, id)`, and a suite that let the clock order its fixtures could
 * not seed two submissions a known distance apart.
 */
async function seedSubmission({
	assetId,
	status,
	result,
	waterPurveyorId = wpA,
	createdAt,
	testDate = null as string | null,
}: {
	assetId: string | null;
	status: "draft" | "submitted";
	result: "pass" | "fail" | null;
	waterPurveyorId?: string;
	createdAt?: string;
	testDate?: string | null;
}) {
	const id = randomUUID();

	await pool.query(
		`insert into test_submissions
		   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
		    wizard_data, test_date, test_result, signature_method, created_at)
		 values ($1, $2, $3, $4, $5::submission_status, 'RP', '{}'::jsonb,
		         $6, $7::test_result, 'signed', coalesce($8::timestamptz, now()))`,
		[
			id,
			assetId,
			certifierId,
			waterPurveyorId,
			status,
			testDate,
			result,
			createdAt ?? null,
		],
	);

	return id;
}

/**
 * Submits a **new** test record, the way the certifier wizard's submit will:
 * insert the submitted row, then apply what its result means through the one
 * exported lifecycle helper. A re-test is always a call to this — never an
 * edit of an earlier submission's `test_result`.
 */
async function submitTest({
	assetId,
	result,
	waterPurveyorId = wpA,
	createdAt,
	testDate = null,
}: {
	assetId: string | null;
	result: "pass" | "fail";
	waterPurveyorId?: string;
	createdAt?: string | Date;
	testDate?: string | null;
}) {
	const id = await seedSubmission({
		assetId,
		status: "submitted",
		result,
		waterPurveyorId,
		createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
		testDate,
	});

	await applySubmittedTestResult({
		submissionId: id,
		bfaAssetId: assetId,
		testResult: result,
		waterPurveyorId,
		trigger: "test_submitted",
	});

	return id;
}

/** The correction form's whole record, defaulted to an untouched fail. */
function correction(
	id: string,
	overrides: Partial<UpdateInput> = {},
): UpdateInput {
	return {
		id,
		bfaType: "RP",
		submittedBinText: null,
		testDate: "2026-09-01",
		testResult: "fail",
		signatureMethod: "signed",
		signatureData: null,
		wizardData: {},
		...overrides,
	} as UpdateInput;
}

async function jobsForSubmission(submissionId: string) {
	const { rows } = await pool.query<{
		id: string;
		job_type: string;
		status: string;
		run_at: Date;
		attempts: number;
		last_error: string | null;
		bfa_asset_id: string | null;
		provider_message_id: string | null;
		delivery_payload: Record<string, unknown> | null;
	}>(
		`select id, job_type, status, run_at, attempts, last_error, bfa_asset_id,
		        provider_message_id, delivery_payload
		   from scheduled_jobs where test_submission_id = $1
		  order by created_at`,
		[submissionId],
	);

	return rows;
}

/** Claims the submission's one live failure job, as the loop's claim would. */
async function claimFailureJob(submissionId: string) {
	const { rows } = await pool.query(
		`update scheduled_jobs set status = 'running'
		  where test_submission_id = $1 and status = 'pending'
		  returning *`,
		[submissionId],
	);

	expect(rows).toHaveLength(1);

	// The pg row is snake_case; re-read through Drizzle for the typed shape.
	const { scheduledJobs } = await import("@bfa-platform/db/schema");
	const { eq } = await import("drizzle-orm");
	const [job] = await db
		.select()
		.from(scheduledJobs)
		.where(eq(scheduledJobs.id, (rows[0] as { id: string }).id));

	if (!job) throw new Error("claimed job vanished");

	return job;
}

/**
 * The provider stand-in from the Workflow 1 suite: honours the idempotency
 * contract — a repeated key returns the original id and sends nothing.
 */
function fakeProvider() {
	const sent = new Map<string, { id: string; body: string }>();
	const calls: { key: string | undefined; to: string }[] = [];
	const state = {
		refuse: false,
		acceptThenLoseResponse: false,
		sender: {
			from: "Kalani Notices <notices@kalani.example>",
			replyTo: "office@kalani.example",
		},
	};

	const driver: EmailDriver = {
		name: "provider",
		async senderIdentity() {
			return { ...state.sender };
		},
		async send(message) {
			const { from, replyTo } = message.sender ?? state.sender;
			calls.push({ key: message.idempotencyKey, to: message.to });

			if (state.refuse) throw new Error("Resend refused the send (503)");

			const body = JSON.stringify({
				from,
				replyTo,
				to: message.to,
				subject: message.subject,
				html: message.html,
				tags: message.tags,
			});
			const key = message.idempotencyKey ?? `unkeyed-${calls.length}`;
			const previous = sent.get(key);

			if (previous && previous.body !== body) {
				throw new Error("409 invalid_idempotent_request");
			}

			const id = previous?.id ?? `re_${randomUUID()}`;
			if (!previous) sent.set(key, { id, body });

			if (state.acceptThenLoseResponse) {
				throw new Error("socket hang up after the provider accepted");
			}

			return { id, driver: "provider" };
		},
	};

	return {
		driver,
		state,
		calls,
		emailsSent: () => sent.size,
		idFor: (key: string) => sent.get(key)?.id,
	};
}

describeDb("Workflow 3 — failure notice and fail list", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		({ db } = await import("@bfa-platform/db"));
		({ runFailureNoticeJob } = await import("./failure-notice"));
		({ runSchedulerTick } = await import("./index"));
		({ applySubmittedTestResult } = await import("./submission-lifecycle"));
		({ listFailingAssets } = await import("../routers/dashboard"));

		const { t } = await import("../index");
		const { appRouter } = await import("../routers/index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as unknown as ReturnType<typeof callerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Kalani Water Works', 'WF3-A', 'active'),
			        ($2, 'Kalani Water Works', 'WF3-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string, string][] = [
			[ids.adminA, wpA, "Aria Admin", "wp_admin"],
			[ids.adminB, wpB, "Bruno Admin", "wp_admin"],
			[ids.certProfile, null, "Alana Kealoha", "certifier"],
		];

		for (const [id, wp, name, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, $3, $4::global_role, 'active')`,
				[id, wp, name, role],
			);
		}

		await pool.query(
			`insert into certifiers (id, profile_id, company, id_number, status)
			 values ($1, $2, 'Island Backflow', 'HI-31', 'active')`,
			[certifierId, ids.certProfile],
		);
		await pool.query(
			`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
			 values ($1, $2, 'active'), ($1, $3, 'active')`,
			[certifierId, wpA, wpB],
		);

		const customers: [string, string, string, string, string][] = [
			[
				customerIds.primary,
				wpA,
				"Ampersand & <script>Co</script>",
				"wf3-primary@example.com",
				"active",
			],
			[
				customerIds.replacement,
				wpA,
				"Tomas Reyes",
				"wf3-tomas@example.com",
				"active",
			],
			[
				customerIds.suspended,
				wpA,
				"Halted Holdings",
				"wf3-halted@example.com",
				"suspended",
			],
			[customerIds.noEmail, wpA, "Silent Partner", "", "active"],
			[
				customerIds.foreign,
				wpB,
				"Marta Ellison",
				"wf3-foreign@example.com",
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

		const companies: [
			string,
			string,
			string,
			string | null,
			string | null,
			string,
		][] = [
			[
				repairIds.activeFull,
				wpA,
				"Aloha Backflow Repair",
				"(808) 555-0100",
				REPAIR_EMAIL,
				"active",
			],
			[repairIds.activeBare, wpA, "Valve <b>Works</b>", null, null, "active"],
			[
				repairIds.inactive,
				wpA,
				"Defunct Repairs",
				"(808) 555-0199",
				null,
				"inactive",
			],
			[
				repairIds.foreign,
				wpB,
				"Foreign Fixers",
				"(808) 555-0177",
				null,
				"active",
			],
		];

		for (const [id, wp, name, phone, email, status] of companies) {
			await pool.query(
				`insert into repair_companies (id, water_purveyor_id, company_name, phone, email, status)
				 values ($1, $2, $3, $4, $5, $6::repair_company_status)`,
				[id, wp, name, phone, email, status],
			);
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();

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
			"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from repair_companies where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from customers where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id = $1",
			[certifierId],
		);
		await pool.query("delete from certifiers where id = $1", [certifierId]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query(
			"delete from water_purveyors where id = any($1::uuid[])",
			wps,
		);
		await pool.end();
	});

	describe("what queues a failure notice, and what never does", () => {
		it("a newly submitted failed test queues one job, due immediately", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			const lines = captureLogs();
			const before = Date.now();
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			const jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toMatchObject({
				job_type: "failure_notice",
				status: "pending",
				// Submission-scoped on purpose: two fails for one assembly are two
				// notices, and the live-asset uniqueness rule must not collapse them.
				bfa_asset_id: null,
			});
			// Due now — not in 30 days. The email and the fail list are separate
			// clocks.
			expect(jobs[0]?.run_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
			expect(jobs[0]?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

			const scheduled = eventsNamed(lines, "scheduler_job_scheduled");
			expect(scheduled).toHaveLength(1);
			expect(scheduled[0]).toMatchObject({
				job_type: "failure_notice",
				wp_id: wpA,
				asset_id: asset.id,
				submission_id: submissionId,
				trigger: "test_submitted",
			});
		});

		it("queues the notice when a failed no-BIN submission is later linked", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({ assetId: null, result: "fail" });

			// Unlinked, it represents no assembly and queues nothing.
			expect(await jobsForSubmission(submissionId)).toHaveLength(0);

			await callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
				submissionId,
				assetId: asset.id,
			});

			const jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.status).toBe("pending");
		});

		it("waits on a no-BIN asset, and queues the notice once the WP assigns its BIN", async () => {
			const asset = await seedAsset({
				currentCustomerId: customerIds.primary,
				bin: null,
			});
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			// Linked, but to an assembly the register cannot name yet.
			expect(await jobsForSubmission(submissionId)).toHaveLength(0);

			await callerFor(ids.adminA).assets.updateAsset({
				id: asset.id,
				bin: `WF3-ASSIGNED-${randomUUID().slice(0, 6)}`,
				bfaType: "RP",
				serviceAddress: "12 Kalani Street",
				make: "Watts",
				model: "LF909",
				serialNumber: "SN-WF3",
				size: "1",
				assemblyLocation: "Front yard",
				annualTestDate: "2027-09-01",
			});

			const jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.status).toBe("pending");
		});

		it("a failed draft queues nothing and sends nothing", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "draft",
				result: "fail",
			});

			const lines = captureLogs();
			const result = await runSchedulerTick();

			expect(await jobsForSubmission(submissionId)).toHaveLength(0);
			expect(result.sent).toBe(0);
			expect(deliveries(lines)).toHaveLength(0);
		});

		it("two failed tests for one assembly are two notices — the live-asset rule does not collapse them", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			const first = await submitTest({ assetId: asset.id, result: "fail" });
			const second = await submitTest({ assetId: asset.id, result: "fail" });

			expect(await jobsForSubmission(first)).toHaveLength(1);
			expect(await jobsForSubmission(second)).toHaveLength(1);
		});
	});

	describe("the WP correction path (a correction, not a re-test)", () => {
		// These exercise the purveyor's correction feature, which rewrites a
		// submitted row by design. They are about what a correction does to that
		// row's own notice — not a stand-in for a re-test, which is always a new
		// submitted record (`submitTest`).

		it("a correction that records a fail queues the notice, attributed to the WP actor", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});

			const lines = captureLogs();
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

			expect(await jobsForSubmission(submissionId)).toHaveLength(1);
			expect(eventsNamed(lines, "scheduler_job_scheduled")[0]).toMatchObject({
				actor_id: ids.adminA,
				submission_id: submissionId,
				trigger: "test_submission_corrected",
			});
		});

		it("saving a still-failing correction again queues no second notice", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			// A real change that leaves the row failing.
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId, { submittedBinText: "typed on the day" }),
			);

			expect(await jobsForSubmission(submissionId)).toHaveLength(1);
		});

		it("does not re-notify a fail the customer was already told about", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			await runSchedulerTick();

			const [sentJob] = await jobsForSubmission(submissionId);
			expect(sentJob?.status).toBe("completed");

			// A later correction that still says fail lands on the completed slot
			// and writes nothing — the settled-submission index at work.
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId, { submittedBinText: "second look" }),
			);

			expect(await jobsForSubmission(submissionId)).toHaveLength(1);
		});

		it("correcting a mis-recorded fail to pass withdraws that row's unsent notice", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId, { testResult: "pass" }),
			);

			const jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.status).toBe("cancelled");
			expect(jobs[0]?.last_error).toMatch(/no longer a failing test/i);
		});

		it("a correction to pass beats a handler already inside the job", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			const job = await claimFailureJob(submissionId);

			// The correction lands while the handler holds the row.
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId, { testResult: "pass" }),
			);

			captureLogs();
			const outcome = await runFailureNoticeJob(job);

			expect(["cancelled", "superseded"]).toContain(outcome.kind);

			const [row] = await jobsForSubmission(submissionId);
			expect(row?.status).toBe("cancelled");
		});
	});

	describe("the failure email", () => {
		it("mails the current customer, listing only active repair companies by name and phone — never an email", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
				testDate: "2026-09-01",
			});

			const lines = captureLogs();
			// No wp_feature_flags row exists for wpA: this send is also the proof
			// that the failure notice is not gated on `automated_notices`.
			const result = await runSchedulerTick();

			expect(result.sent).toBe(1);

			const [delivery] = deliveries(lines, "wf3-primary@example.com");
			expect(delivery).toBeDefined();

			const html = String(delivery?.html);
			expect(String(delivery?.subject)).toContain("test failed");

			// Active companies, name and phone.
			expect(html).toContain("Aloha Backflow Repair");
			expect(html).toContain("(808) 555-0100");
			// Escaped, not trusted.
			expect(html).toContain("Valve &lt;b&gt;Works&lt;/b&gt;");
			expect(html).not.toContain("Valve <b>Works</b>");
			expect(html).toContain("&lt;script&gt;Co&lt;/script&gt;");
			// Inactive and foreign companies are not in the list.
			expect(html).not.toContain("Defunct Repairs");
			expect(html).not.toContain("Foreign Fixers");
			// A repair company's email address never reaches a customer.
			expect(html).not.toContain(REPAIR_EMAIL);
			// The assembly the customer is being told about.
			expect(html).toContain(asset.bin);
			expect(html).toContain("12 Kalani Street");

			const [completed] = eventsNamed(lines, "scheduler_job_completed");
			expect(completed).toMatchObject({
				job_type: "failure_notice",
				wp_id: wpA,
				asset_id: asset.id,
				customer_id: customerIds.primary,
				submission_id: submissionId,
				repair_company_count: 2,
			});
		});

		it("holds a blocked purveyor's notice but still mails the same address for another purveyor", async () => {
			// One person, a customer of both purveyors under one email. Blocking
			// wpA silences wpA's mail to them, and only wpA's.
			const sharedInB = randomUUID();
			await pool.query(
				`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
				 values ($1, $2, 'Shared Address', 'wf3-primary@example.com', 'standard', 'active')`,
				[sharedInB, wpB],
			);
			const assetA = await seedAsset({
				currentCustomerId: customerIds.primary,
			});
			const assetB = await seedAsset({
				waterPurveyorId: wpB,
				currentCustomerId: sharedInB,
			});
			const failA = await submitTest({ assetId: assetA.id, result: "fail" });
			await submitTest({
				assetId: assetB.id,
				result: "fail",
				waterPurveyorId: wpB,
			});

			await pool.query(
				"update water_purveyors set status = 'blocked' where id = $1",
				[wpA],
			);
			try {
				const lines = captureLogs();
				const result = await runSchedulerTick();

				expect(result.sent).toBe(1);
				expect(result.held).toBe(1);

				const [delivery] = deliveries(lines, "wf3-primary@example.com");
				expect(delivery).toBeDefined();
				expect(deliveries(lines, "wf3-primary@example.com")).toHaveLength(1);
				expect(String(delivery?.html)).toContain(assetB.bin);
				expect(String(delivery?.html)).not.toContain(assetA.bin);

				const [heldJob] = await jobsForSubmission(failA);
				expect(heldJob).toMatchObject({ status: "pending", attempts: 0 });
				expect(heldJob?.last_error).toMatch(/purveyor is blocked/i);
			} finally {
				await pool.query(
					"update water_purveyors set status = 'active' where id = $1",
					[wpA],
				);
			}
		});

		it("resolves the recipient at send time, not at fail time", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			await submitTest({ assetId: asset.id, result: "fail" });

			// The occupant changes between the fail and the tick.
			await pool.query(
				"update bfa_assets set current_customer_id = $1 where id = $2",
				[customerIds.replacement, asset.id],
			);

			const lines = captureLogs();
			await runSchedulerTick();

			expect(deliveries(lines, "wf3-tomas@example.com")).toHaveLength(1);
			expect(deliveries(lines, "wf3-primary@example.com")).toHaveLength(0);
		});

		it("holds — no send, job stays pending — for a suspended customer", async () => {
			const asset = await seedAsset({
				currentCustomerId: customerIds.suspended,
			});
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			const lines = captureLogs();
			const result = await runSchedulerTick();

			expect(result.held).toBe(1);
			expect(result.sent).toBe(0);
			expect(deliveries(lines)).toHaveLength(0);

			const [job] = await jobsForSubmission(submissionId);
			expect(job?.status).toBe("pending");
			expect(job?.last_error).toMatch(/suspended/i);
			// No attempt consumed: nothing failed.
			expect(job?.attempts).toBe(0);
		});

		it("holds for a customer with no email, and for an asset with no customer", async () => {
			const noEmailAsset = await seedAsset({
				currentCustomerId: customerIds.noEmail,
			});
			const orphanAsset = await seedAsset({ currentCustomerId: null });

			const noEmailSubmission = await submitTest({
				assetId: noEmailAsset.id,
				result: "fail",
			});
			const orphanSubmission = await submitTest({
				assetId: orphanAsset.id,
				result: "fail",
			});

			const lines = captureLogs();
			const result = await runSchedulerTick();

			expect(result.held).toBe(2);
			expect(deliveries(lines)).toHaveLength(0);
			expect((await jobsForSubmission(noEmailSubmission))[0]?.status).toBe(
				"pending",
			);
			expect((await jobsForSubmission(orphanSubmission))[0]?.status).toBe(
				"pending",
			);
		});

		it("cancels the unsent notice instead of sending when a passing re-test is submitted after the fail", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const failId = await submitTest({ assetId: asset.id, result: "fail" });

			// The re-test: a new submitted record, before the tick reaches the job.
			await submitTest({ assetId: asset.id, result: "pass" });

			const lines = captureLogs();
			const result = await runSchedulerTick();

			expect(result.cancelled).toBe(1);
			expect(result.sent).toBe(0);
			expect(deliveries(lines)).toHaveLength(0);

			const [job] = await jobsForSubmission(failId);
			expect(job?.status).toBe("cancelled");
			expect(job?.last_error).toMatch(/passing test.*resolves/i);
		});

		it("a passing re-test beats a handler already inside the job", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const failId = await submitTest({ assetId: asset.id, result: "fail" });

			const job = await claimFailureJob(failId);

			// The re-test lands while the handler holds the row.
			await submitTest({ assetId: asset.id, result: "pass" });

			const lines = captureLogs();
			const outcome = await runFailureNoticeJob(job);

			expect(outcome.kind).toBe("cancelled");
			expect(deliveries(lines)).toHaveLength(0);

			const [row] = await jobsForSubmission(failId);
			expect(row?.status).toBe("cancelled");
		});

		it("never mails another tenant: a cross-tenant asset link is cancelled, not sent", async () => {
			// A link the application refuses to create, written directly — a
			// restore or a pre-0009 row. The handler must refuse to mail wpB's
			// customer about it.
			const foreignAsset = await seedAsset({
				waterPurveyorId: wpB,
				currentCustomerId: customerIds.foreign,
			});
			const submissionId = await seedSubmission({
				assetId: foreignAsset.id,
				status: "submitted",
				result: "fail",
			});
			await pool.query(
				`insert into scheduled_jobs (job_type, test_submission_id, water_purveyor_id, run_at, status)
				 values ('failure_notice', $1, $2, now(), 'pending')`,
				[submissionId, wpA],
			);

			const lines = captureLogs();
			const result = await runSchedulerTick();

			expect(result.cancelled).toBe(1);
			expect(deliveries(lines)).toHaveLength(0);

			const [job] = await jobsForSubmission(submissionId);
			expect(job?.status).toBe("cancelled");
		});
	});

	describe("delivery idempotency, retry and recovery", () => {
		it("a refused send retries under the same key and delivers exactly one email", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			const provider = fakeProvider();
			provider.state.refuse = true;

			captureLogs();
			const first = await runSchedulerTick({ driver: provider.driver });
			expect(first.retrying).toBe(1);

			const [afterFailure] = await jobsForSubmission(submissionId);
			expect(afterFailure?.status).toBe("pending");
			expect(afterFailure?.attempts).toBe(1);
			// The payload froze before the first attempt and stays for the replay.
			expect(afterFailure?.delivery_payload).toBeTruthy();

			provider.state.refuse = false;
			const later = new Date(Date.now() + 10 * 60_000);
			const second = await runSchedulerTick({
				now: later,
				driver: provider.driver,
			});

			expect(second.sent).toBe(1);
			expect(provider.emailsSent()).toBe(1);
			expect(new Set(provider.calls.map((call) => call.key)).size).toBe(1);

			const [done] = await jobsForSubmission(submissionId);
			expect(done?.status).toBe("completed");
			expect(done?.provider_message_id).toBeTruthy();
			expect(done?.delivery_payload).toBeNull();
		});

		it("an accepted send whose response was lost is settled by replay, not by a second email", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await submitTest({
				assetId: asset.id,
				result: "fail",
			});

			const provider = fakeProvider();
			provider.state.acceptThenLoseResponse = true;

			captureLogs();
			const first = await runSchedulerTick({ driver: provider.driver });
			expect(first.retrying).toBe(1);
			expect(provider.emailsSent()).toBe(1);

			provider.state.acceptThenLoseResponse = false;
			const later = new Date(Date.now() + 10 * 60_000);
			const second = await runSchedulerTick({
				now: later,
				driver: provider.driver,
			});

			expect(second.sent).toBe(1);
			// Still exactly one email; the replay returned the original id.
			expect(provider.emailsSent()).toBe(1);

			const [done] = await jobsForSubmission(submissionId);
			const key = provider.calls[0]?.key;
			expect(done?.provider_message_id).toBe(
				key ? provider.idFor(key) : undefined,
			);
		});
	});

	describe("the fail list — 30 days without a passing re-test", () => {
		// Every scenario submits new records at explicit instants and reads the
		// list at an explicit `now`, so the 30-day boundary is exact. A re-test is
		// a new `submitTest` call, never an edit of an earlier row.

		const T0 = new Date("2026-01-10T12:00:00.000Z");
		const DAY = 86_400_000;
		const after = (ms: number) => new Date(T0.getTime() + ms);

		async function listedAt(now: Date, assetId: string) {
			const rows = await listFailingAssets({ waterPurveyorId: wpA, now });

			return rows.filter((row) => row.id === assetId);
		}

		it("is absent at 29 days and one millisecond short of 30, and present at exactly 30", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			await submitTest({ assetId: asset.id, result: "fail", createdAt: T0 });

			expect(await listedAt(after(0), asset.id)).toEqual([]);
			expect(await listedAt(after(29 * DAY), asset.id)).toEqual([]);
			expect(await listedAt(after(30 * DAY - 1), asset.id)).toEqual([]);

			const rows = await listedAt(after(30 * DAY), asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				bin: asset.bin,
				bfaType: "RP",
				serviceAddress: "12 Kalani Street",
				currentCustomerName: "Ampersand & <script>Co</script>",
				failingSince: "2026-01-10",
			});
		});

		it("never lists an asset whose passing re-test arrived before day 30", async () => {
			const asset = await seedAsset();
			await submitTest({ assetId: asset.id, result: "fail", createdAt: T0 });
			await submitTest({
				assetId: asset.id,
				result: "pass",
				createdAt: after(10 * DAY),
			});

			expect(await listedAt(after(30 * DAY), asset.id)).toEqual([]);
			expect(await listedAt(after(90 * DAY), asset.id)).toEqual([]);
		});

		it("removes an asset that had already entered as soon as a passing re-test is submitted", async () => {
			const asset = await seedAsset();
			await submitTest({ assetId: asset.id, result: "fail", createdAt: T0 });

			expect(await listedAt(after(31 * DAY), asset.id)).toHaveLength(1);

			await submitTest({
				assetId: asset.id,
				result: "pass",
				createdAt: after(32 * DAY),
			});

			expect(await listedAt(after(32 * DAY), asset.id)).toEqual([]);
			expect(await listedAt(after(60 * DAY), asset.id)).toEqual([]);
		});

		it("does not reset the 30-day clock or add a row for a later fail in the same episode", async () => {
			const asset = await seedAsset();
			await submitTest({ assetId: asset.id, result: "fail", createdAt: T0 });
			await submitTest({
				assetId: asset.id,
				result: "fail",
				createdAt: after(20 * DAY),
			});

			// Were the second fail to restart the clock, this would be day 10.
			expect(await listedAt(after(29 * DAY), asset.id)).toEqual([]);

			const rows = await listedAt(after(30 * DAY), asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.failingSince).toBe("2026-01-10");
		});

		it("starts a fresh 30-day episode for a failure after a passing re-test", async () => {
			const asset = await seedAsset();
			await submitTest({ assetId: asset.id, result: "fail", createdAt: T0 });
			await submitTest({
				assetId: asset.id,
				result: "pass",
				createdAt: after(5 * DAY),
			});
			await submitTest({
				assetId: asset.id,
				result: "fail",
				createdAt: after(10 * DAY),
			});

			// 35 days after the first fail, but only 25 into the new episode.
			expect(await listedAt(after(35 * DAY), asset.id)).toEqual([]);

			const rows = await listedAt(after(40 * DAY), asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.failingSince).toBe("2026-01-20");
		});

		it("counts submitted rows only: a failed draft and an unlinked fail put nothing on the list", async () => {
			const asset = await seedAsset();

			await seedSubmission({
				assetId: asset.id,
				status: "draft",
				result: "fail",
				createdAt: T0.toISOString(),
			});
			const unlinked = await submitTest({
				assetId: null,
				result: "fail",
				createdAt: T0,
			});

			expect(await listedAt(after(60 * DAY), asset.id)).toEqual([]);

			// Once the WP resolves the no-BIN fail to this asset, it counts from
			// its own submission time — already more than 30 days ago here.
			await callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
				submissionId: unlinked,
				assetId: asset.id,
			});

			const rows = await listedAt(after(60 * DAY), asset.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.failingSince).toBe("2026-01-10");
		});

		it("orders by submission-event time, never by the certifier-typed test_date", async () => {
			// A pass submitted after the fail clears it, even though its
			// test_date is earlier than the fail's.
			const cleared = await seedAsset();
			await submitTest({
				assetId: cleared.id,
				result: "fail",
				createdAt: T0,
				testDate: "2026-03-01",
			});
			await submitTest({
				assetId: cleared.id,
				result: "pass",
				createdAt: after(1 * DAY),
				testDate: "2026-01-01",
			});

			// And the reverse: a fail submitted after a pass is unresolved, even
			// though the pass carries the later test_date.
			const unresolved = await seedAsset();
			await submitTest({
				assetId: unresolved.id,
				result: "pass",
				createdAt: T0,
				testDate: "2026-03-01",
			});
			await submitTest({
				assetId: unresolved.id,
				result: "fail",
				createdAt: after(1 * DAY),
				testDate: "2026-01-01",
			});

			expect(await listedAt(after(60 * DAY), cleared.id)).toEqual([]);
			expect(await listedAt(after(60 * DAY), unresolved.id)).toHaveLength(1);
		});

		it("defaults to oldest unresolved failure first", async () => {
			const older = await seedAsset();
			const newer = await seedAsset();

			await submitTest({
				assetId: newer.id,
				result: "fail",
				createdAt: after(5 * DAY),
			});
			await submitTest({ assetId: older.id, result: "fail", createdAt: T0 });

			const rows = (
				await listFailingAssets({ waterPurveyorId: wpA, now: after(60 * DAY) })
			).filter((row) => row.id === older.id || row.id === newer.id);

			expect(rows.map((row) => row.id)).toEqual([older.id, newer.id]);
		});

		it("dashboard.failList applies the rule to the real clock, per tenant, and leaks nothing across tenants", async () => {
			const now = Date.now();

			const fresh = await seedAsset();
			const aged = await seedAsset();
			await submitTest({ assetId: fresh.id, result: "fail" });
			await submitTest({
				assetId: aged.id,
				result: "fail",
				createdAt: new Date(now - 31 * DAY),
			});

			const assetB = await seedAsset({
				waterPurveyorId: wpB,
				currentCustomerId: customerIds.foreign,
			});
			await submitTest({
				assetId: assetB.id,
				result: "fail",
				waterPurveyorId: wpB,
				createdAt: new Date(now - 31 * DAY),
			});
			// A wpA submission pointing at wpB's asset — written directly, since
			// the application refuses to create one.
			await seedSubmission({
				assetId: assetB.id,
				status: "submitted",
				result: "fail",
				waterPurveyorId: wpA,
				createdAt: new Date(now - 31 * DAY).toISOString(),
			});

			const rowsA = await callerFor(ids.adminA).dashboard.failList();
			const rowsB = await callerFor(ids.adminB).dashboard.failList();

			// Today's fail has emailed but is not on the list yet; the 31-day one is.
			expect(rowsA.some((row) => row.id === fresh.id)).toBe(false);
			expect(rowsA.some((row) => row.id === aged.id)).toBe(true);

			// wpB sees its own aged failure; wpA sees nothing of it — not even
			// through its own mispointed submission.
			expect(rowsB.some((row) => row.id === assetB.id)).toBe(true);
			expect(rowsA.some((row) => row.id === assetB.id)).toBe(false);
			expect(rowsA.some((row) => row.bin === assetB.bin)).toBe(false);
			expect(rowsB.some((row) => row.id === aged.id)).toBe(false);
		});
	});

	describe("regression — the escalation chain is untouched", () => {
		it("a submitted fail cancels nothing an escalation had pending", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			// A live reminder, as the chain would have queued it.
			await pool.query(
				`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
				 values ('reminder', $1, $2, '2027-01-01T10:00:00Z', 'pending')`,
				[asset.id, wpA],
			);

			await submitTest({ assetId: asset.id, result: "fail" });

			const { rows } = await pool.query(
				"select status from scheduled_jobs where bfa_asset_id = $1 and job_type = 'reminder'",
				[asset.id],
			);
			expect(rows[0]?.status).toBe("pending");
		});

		it("a submitted passing re-test cancels the chain", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			await pool.query(
				`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
				 values ('late_notice_1', $1, $2, '2027-01-01T10:00:00Z', 'pending')`,
				[asset.id, wpA],
			);

			await submitTest({ assetId: asset.id, result: "pass" });

			const { rows } = await pool.query(
				"select status, last_error from scheduled_jobs where bfa_asset_id = $1 and job_type = 'late_notice_1'",
				[asset.id],
			);
			expect(rows[0]?.status).toBe("cancelled");
			expect(String(rows[0]?.last_error)).toMatch(/passing test/i);
		});

		it("a WP correction to pass still cancels the chain, exactly as before", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			await pool.query(
				`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
				 values ('late_notice_1', $1, $2, '2027-01-01T10:00:00Z', 'pending')`,
				[asset.id, wpA],
			);

			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId, { testResult: "pass" }),
			);

			const { rows } = await pool.query(
				"select status, last_error from scheduled_jobs where bfa_asset_id = $1 and job_type = 'late_notice_1'",
				[asset.id],
			);
			expect(rows[0]?.status).toBe("cancelled");
			expect(String(rows[0]?.last_error)).toMatch(/passing test/i);
		});
	});
});
