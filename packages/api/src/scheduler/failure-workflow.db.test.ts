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
} = {}) {
	binCounter += 1;
	const id = randomUUID();
	const bin = `WF3-${binCounter}-${randomUUID().slice(0, 6)}`;

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
		it("queues one job, due immediately, when a correction records a fail", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});

			const lines = captureLogs();
			const before = Date.now();
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

			const jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toMatchObject({
				job_type: "failure_notice",
				status: "pending",
				// Submission-scoped on purpose: two fails for one assembly are two
				// notices, and the live-asset uniqueness rule must not collapse them.
				bfa_asset_id: null,
			});
			expect(jobs[0]?.run_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
			expect(jobs[0]?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

			const scheduled = eventsNamed(lines, "scheduler_job_scheduled");
			expect(scheduled).toHaveLength(1);
			expect(scheduled[0]).toMatchObject({
				job_type: "failure_notice",
				actor_id: ids.adminA,
				wp_id: wpA,
				asset_id: asset.id,
				submission_id: submissionId,
				trigger: "test_submission_corrected",
			});
		});

		it("queues the notice when a failed no-BIN submission is later linked", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: null,
				status: "submitted",
				result: "fail",
			});

			expect(await jobsForSubmission(submissionId)).toHaveLength(0);

			await callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
				submissionId,
				assetId: asset.id,
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

		it("saving a still-failing correction again queues no second notice", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			const caller = callerFor(ids.adminA);

			await caller.submittedTests.updateSubmittedTest(correction(submissionId));
			// A real change that leaves the row failing.
			await caller.submittedTests.updateSubmittedTest(
				correction(submissionId, { submittedBinText: "typed on the day" }),
			);

			expect(await jobsForSubmission(submissionId)).toHaveLength(1);
		});

		it("does not re-notify a fail the customer was already told about", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			const caller = callerFor(ids.adminA);

			await caller.submittedTests.updateSubmittedTest(correction(submissionId));
			await runSchedulerTick();

			const [sentJob] = await jobsForSubmission(submissionId);
			expect(sentJob?.status).toBe("completed");

			// A later correction that still says fail lands on the completed slot
			// and writes nothing — the settled-submission index at work.
			await caller.submittedTests.updateSubmittedTest(
				correction(submissionId, { submittedBinText: "second look" }),
			);

			expect(await jobsForSubmission(submissionId)).toHaveLength(1);
		});

		it("correcting a fail to pass withdraws the unsent notice; back to fail earns one fresh one", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			const caller = callerFor(ids.adminA);

			await caller.submittedTests.updateSubmittedTest(correction(submissionId));
			await caller.submittedTests.updateSubmittedTest(
				correction(submissionId, { testResult: "pass" }),
			);

			let jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.status).toBe("cancelled");
			expect(jobs[0]?.last_error).toMatch(/no longer a failing test/i);

			await caller.submittedTests.updateSubmittedTest(
				correction(submissionId, { testResult: "fail" }),
			);

			jobs = await jobsForSubmission(submissionId);
			expect(jobs).toHaveLength(2);
			expect(jobs[1]?.status).toBe("pending");
		});

		it("two fails for one assembly are two notices — the live-asset rule does not collapse them", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const first = await seedSubmission({
				assetId: null,
				status: "submitted",
				result: "fail",
			});
			const second = await seedSubmission({
				assetId: null,
				status: "submitted",
				result: "fail",
			});
			const caller = callerFor(ids.adminA);

			await caller.submittedTests.linkSubmissionAsset({
				submissionId: first,
				assetId: asset.id,
			});
			await caller.submittedTests.linkSubmissionAsset({
				submissionId: second,
				assetId: asset.id,
			});

			expect(await jobsForSubmission(first)).toHaveLength(1);
			expect(await jobsForSubmission(second)).toHaveLength(1);
		});
	});

	describe("the failure email", () => {
		it("mails the current customer, listing only active repair companies by name and phone — never an email", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId, { testDate: "2026-09-01" }),
			);

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

		it("resolves the recipient at send time, not at fail time", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

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
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

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
			const caller = callerFor(ids.adminA);

			const noEmailSubmission = await seedSubmission({
				assetId: noEmailAsset.id,
				status: "submitted",
				result: null,
			});
			const orphanSubmission = await seedSubmission({
				assetId: orphanAsset.id,
				status: "submitted",
				result: null,
			});

			await caller.submittedTests.updateSubmittedTest(
				correction(noEmailSubmission),
			);
			await caller.submittedTests.updateSubmittedTest(
				correction(orphanSubmission),
			);

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

		it("cancels instead of sending when a pass was submitted after the fail", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

			// A passing re-test lands before the tick gets to the job.
			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "pass",
			});

			const lines = captureLogs();
			const result = await runSchedulerTick();

			expect(result.cancelled).toBe(1);
			expect(result.sent).toBe(0);
			expect(deliveries(lines)).toHaveLength(0);

			const [job] = await jobsForSubmission(submissionId);
			expect(job?.status).toBe("cancelled");
			expect(job?.last_error).toMatch(/passing test.*resolves/i);
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

			// wpA's job: the submission names a tenant the job does not, so it is
			// not wpA's submission to mail. (The submission itself is wpB's row.)
			const [job] = await jobsForSubmission(submissionId);
			expect(job?.status).toBe("cancelled");
		});
	});

	describe("delivery idempotency, retry and recovery", () => {
		it("a refused send retries under the same key and delivers exactly one email", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

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
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

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

		it("a correction to pass beats a handler already inside the job", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });
			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			const caller = callerFor(ids.adminA);
			await caller.submittedTests.updateSubmittedTest(correction(submissionId));

			const job = await claimFailureJob(submissionId);

			// The correction lands while the handler holds the row.
			await caller.submittedTests.updateSubmittedTest(
				correction(submissionId, { testResult: "pass" }),
			);

			captureLogs();
			const outcome = await runFailureNoticeJob(job);

			// The handler re-reads the submission and finds it is no longer a
			// failing test; the row was already cancelled underneath it.
			expect(["cancelled", "superseded"]).toContain(outcome.kind);

			const [row] = await jobsForSubmission(submissionId);
			expect(row?.status).toBe("cancelled");
		});
	});

	describe("dashboard.failList — membership computed from history", () => {
		/** Minutes after a fixed origin, so event order is explicit. */
		function at(minutes: number) {
			return new Date(Date.UTC(2026, 0, 10, 12, minutes)).toISOString();
		}

		it("lists a failing asset once, aged from the first fail after the last pass", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			expect(
				(await caller.dashboard.failList()).filter(
					(row) => row.id === asset.id,
				),
			).toEqual([]);

			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "pass",
				createdAt: at(0),
			});
			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "fail",
				createdAt: at(10),
			});
			// A second fail in the same episode: its own notice, but not a second
			// row and not a younger age.
			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "fail",
				createdAt: at(20),
			});

			const rows = (await caller.dashboard.failList()).filter(
				(row) => row.id === asset.id,
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				bin: asset.bin,
				bfaType: "RP",
				serviceAddress: "12 Kalani Street",
				currentCustomerName: "Ampersand & <script>Co</script>",
				failingSince: "2026-01-10",
			});
		});

		it("clears on the next submitted pass and re-enters on a later fail with a fresh age", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await seedAsset();

			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "fail",
				createdAt: at(0),
			});
			expect(
				(await caller.dashboard.failList()).some((row) => row.id === asset.id),
			).toBe(true);

			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "pass",
				createdAt: at(10),
			});
			expect(
				(await caller.dashboard.failList()).some((row) => row.id === asset.id),
			).toBe(false);

			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "fail",
				createdAt: "2026-02-01T12:00:00.000Z",
			});

			const rows = (await caller.dashboard.failList()).filter(
				(row) => row.id === asset.id,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.failingSince).toBe("2026-02-01");
		});

		it("counts submitted rows only: a failed draft and an unlinked fail put nothing on the list", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await seedAsset();

			await seedSubmission({
				assetId: asset.id,
				status: "draft",
				result: "fail",
			});
			const unlinked = await seedSubmission({
				assetId: null,
				status: "submitted",
				result: "fail",
			});

			expect(
				(await caller.dashboard.failList()).some((row) => row.id === asset.id),
			).toBe(false);

			// The moment the WP resolves the no-BIN fail to this asset, it counts.
			await caller.submittedTests.linkSubmissionAsset({
				submissionId: unlinked,
				assetId: asset.id,
			});

			expect(
				(await caller.dashboard.failList()).some((row) => row.id === asset.id),
			).toBe(true);
		});

		it("orders by submission-event time, not by the certifier-typed test_date", async () => {
			const caller = callerFor(ids.adminA);
			const asset = await seedAsset();

			// The fail carries a *later* test_date than the pass — a typo, or a
			// certifier filing out of order. What settles membership is which was
			// submitted last, and that is the pass.
			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "fail",
				createdAt: at(0),
				testDate: "2026-03-01",
			});
			await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: "pass",
				createdAt: at(10),
				testDate: "2026-01-01",
			});

			expect(
				(await caller.dashboard.failList()).some((row) => row.id === asset.id),
			).toBe(false);
		});

		it("is tenant-isolated, and a cross-tenant asset link leaks nothing", async () => {
			const assetB = await seedAsset({
				waterPurveyorId: wpB,
				currentCustomerId: customerIds.foreign,
			});

			await seedSubmission({
				assetId: assetB.id,
				status: "submitted",
				result: "fail",
				waterPurveyorId: wpB,
			});

			// A wpA submission pointing at wpB's asset — written directly, since
			// the application refuses to create one.
			await seedSubmission({
				assetId: assetB.id,
				status: "submitted",
				result: "fail",
				waterPurveyorId: wpA,
			});

			const rowsA = await callerFor(ids.adminA).dashboard.failList();
			const rowsB = await callerFor(ids.adminB).dashboard.failList();

			// wpB sees its own failing asset; wpA sees nothing of it — not even
			// through its own mispointed submission.
			expect(rowsB.some((row) => row.id === assetB.id)).toBe(true);
			expect(rowsA.some((row) => row.id === assetB.id)).toBe(false);
			expect(rowsA.some((row) => row.bin === assetB.bin)).toBe(false);
		});

		it("defaults to oldest unresolved failure first", async () => {
			const caller = callerFor(ids.adminA);
			const older = await seedAsset();
			const newer = await seedAsset();

			await seedSubmission({
				assetId: newer.id,
				status: "submitted",
				result: "fail",
				createdAt: "2026-03-05T12:00:00.000Z",
			});
			await seedSubmission({
				assetId: older.id,
				status: "submitted",
				result: "fail",
				createdAt: "2026-03-01T12:00:00.000Z",
			});

			const rows = (await caller.dashboard.failList()).filter(
				(row) => row.id === older.id || row.id === newer.id,
			);

			expect(rows.map((row) => row.id)).toEqual([older.id, newer.id]);
		});
	});

	describe("regression — the escalation chain is untouched", () => {
		it("a linked fail cancels nothing an escalation had pending", async () => {
			const asset = await seedAsset({ currentCustomerId: customerIds.primary });

			// A live reminder, as the chain would have queued it.
			await pool.query(
				`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
				 values ('reminder', $1, $2, '2027-01-01T10:00:00Z', 'pending')`,
				[asset.id, wpA],
			);

			const submissionId = await seedSubmission({
				assetId: asset.id,
				status: "submitted",
				result: null,
			});
			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				correction(submissionId),
			);

			const { rows } = await pool.query(
				"select status from scheduled_jobs where bfa_asset_id = $1 and job_type = 'reminder'",
				[asset.id],
			);
			expect(rows[0]?.status).toBe("pending");
		});

		it("a corrected pass still cancels the chain, exactly as before", async () => {
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
