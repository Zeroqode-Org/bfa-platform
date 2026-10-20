import { randomUUID } from "node:crypto";

import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
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
import { CUSTOMER_STALE_MESSAGE } from "../lib/customer-revision";
import type { EmailDriver } from "../lib/email";
import {
	addCalendarDays,
	addCalendarYears,
	honoluluToday,
} from "../lib/honolulu-dates";

/**
 * Workflow 2 — the AG rate renewal notice — against real Postgres.
 *
 * What this workflow promises is a handful of conditional writes and one
 * send-time read: a customer-scoped job queued in the same transaction as the
 * customer save, reconciled (never duplicated) when the renewal date or rate
 * changes, gated on `ag_renewal_notice` when it runs, delivered once to the
 * customer's *own* address under the shared frozen-payload / idempotency-key
 * guarantee, and — only after the provider confirmed, only for an active
 * customer whose date is still the notice's — moved to one calendar year after
 * the Hawaii day of the *recorded* delivery (`scheduled_jobs.delivered_at`,
 * never the transition's own clock), with exactly one successor and one
 * `revision` bump, atomically and at most once per job. None of that is
 * observable through a mocked database.
 *
 * Races are made deterministic rather than hoped for: the stand-in provider
 * can run a WP save *during* the send (`state.onSend`), which is exactly the
 * window between a confirmed delivery and the annual transition.
 *
 * Three purveyors, so each flag state is a tenant rather than a toggle a test
 * might forget to restore:
 *
 * - `wpA` has `ag_renewal_notice` **on** and deliberately *no*
 *   `automated_notices` row — every renewal it sends proves the two add-ons
 *   are independent;
 * - `wpB` has an `ag_renewal_notice` row that is **off**;
 * - `wpC` has **no flag row at all**, which must read as off.
 *
 * Opt-in: writes real rows; runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

let db: typeof import("@bfa-platform/db")["db"];
let runAgRenewalJob: typeof import("./ag-renewal")["runAgRenewalJob"];
let AG_RENEWAL_CANCEL_REASONS: typeof import("./ag-renewal")["AG_RENEWAL_CANCEL_REASONS"];
let AG_RENEWAL_HOLD_REASONS: typeof import("./ag-renewal")["AG_RENEWAL_HOLD_REASONS"];
let AG_RENEWAL_NO_SUCCESSOR_REASONS: typeof import("./ag-renewal")["AG_RENEWAL_NO_SUCCESSOR_REASONS"];
let reconcileAgRenewalNotice: typeof import("./ag-renewal")["reconcileAgRenewalNotice"];
let scheduleAgRenewalJob: typeof import("./jobs")["scheduleAgRenewalJob"];
let runSchedulerTick: typeof import("./index")["runSchedulerTick"];
let honolulu: typeof import("../lib/honolulu-dates");

const wpA = randomUUID();
const wpB = randomUUID();
const wpC = randomUUID();

const ids = {
	adminA: randomUUID(),
	adminB: randomUUID(),
	adminC: randomUUID(),
};

/** A future Hawaii day, far enough out that no tick in this suite reaches it. */
const FUTURE_DAY = "2031-03-15";
const LATER_DAY = "2031-06-01";
/**
 * A day already past, so the job is due on the next tick — relative to the
 * real Hawaii day, because the handler's annual transition is too: one year
 * after it is always in the future, whenever this suite runs.
 */
const PAST_DAY = addCalendarDays(honoluluToday(), -3);

/**
 * Where a delivery confirmed now puts the next notice: one calendar year after
 * *today* in Hawaii, never a year after the notice's own (possibly long past)
 * renewal date. Read at assertion time so a suite running across Hawaii
 * midnight compares against the same day the handler used.
 */
function nextYearFromToday() {
	return addCalendarYears(honoluluToday(), 1);
}

let pool: pg.Pool;
let emailCounter = 0;

type CustomerRow = {
	id: string;
	name: string;
	email: string;
	rateCategory: "standard" | "agricultural";
	agRenewalDate: string | null;
	status: "active" | "suspended";
	revision: number;
	updatedAt: Date;
};

type CustomerInput = {
	name: string;
	email: string;
	accountNumber?: string | null;
	address?: string | null;
	status?: "active" | "suspended";
	attachBin?: string | null;
} & (
	| { rateCategory: "standard"; agRenewalDate?: null }
	| { rateCategory: "agricultural"; agRenewalDate: string }
);

/** What every fixture customer is saved with — the address is required. */
const FIXTURE_ADDRESS = "1 Kahale Farm Road";

let rawCallerFor: (profileId: string) => {
	customers: {
		createCustomer: (input: CustomerInput) => Promise<CustomerRow>;
		updateCustomer: (
			input: CustomerInput & { id: string; expectedRevision: number },
		) => Promise<CustomerRow>;
	};
};

type JobRow = {
	id: string;
	job_type: string;
	status: string;
	run_at: Date;
	attempts: number;
	last_error: string | null;
	bfa_asset_id: string | null;
	customer_id: string | null;
	ag_renewal_date: string | null;
	water_purveyor_id: string;
	provider_message_id: string | null;
	delivery_payload: Record<string, unknown> | null;
};

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

function eventsNamed(lines: Record<string, unknown>[], event: string) {
	return lines.filter((line) => line.event === event);
}

/**
 * The customer procedures as this suite uses them. A new customer must occupy
 * an asset, so each one gets a fresh asset of its own, attached by BIN —
 * nothing this workflow reads, since the AG renewal notice is addressed to the
 * customer and never through an asset.
 */
function callerFor(profileId: string): ReturnType<typeof rawCallerFor> {
	const caller = rawCallerFor(profileId);

	return {
		customers: {
			createCustomer: async (input) =>
				caller.customers.createCustomer({
					address: FIXTURE_ADDRESS,
					...input,
					attachBin: await fixtureBinFor(profileId),
				}),
			updateCustomer: (input) => caller.customers.updateCustomer(input),
		},
	};
}

/** A fresh, unoccupied asset in the profile's own purveyor, by BIN. */
async function fixtureBinFor(profileId: string) {
	const { rows } = await pool.query<{ water_purveyor_id: string | null }>(
		"select water_purveyor_id from profiles where id = $1",
		[profileId],
	);
	const wp = rows[0]?.water_purveyor_id;
	if (!wp) return null;

	const bin = `WF2-FX-${randomUUID().slice(0, 8)}`;
	await pool.query(
		`insert into bfa_assets (water_purveyor_id, bin, bfa_type, service_address)
		 values ($1, $2, 'RP', '1 Kahale Farm Road')`,
		[wp, bin],
	);

	return bin;
}

/** A well-formed agricultural customer with a unique address. */
function agCustomer(
	agRenewalDate: string,
	overrides: Partial<CustomerInput> = {},
): CustomerInput {
	emailCounter += 1;

	return {
		name: `Kahale Farms ${emailCounter}`,
		email: `wf2-${emailCounter}-${randomUUID().slice(0, 6)}@example.com`,
		accountNumber: null,
		address: FIXTURE_ADDRESS,
		status: "active",
		rateCategory: "agricultural",
		agRenewalDate,
		...overrides,
	} as CustomerInput;
}

/**
 * The whole-record form the edit dialog sends, from a saved row — including
 * the revision that row was read at, exactly as the real form does. Passing a
 * row the scheduler has since moved on is therefore a stale save, and the
 * server refuses it.
 */
function edit(
	row: CustomerRow,
	changes: Partial<CustomerInput> = {},
): CustomerInput & { id: string; expectedRevision: number } {
	return {
		id: row.id,
		expectedRevision: row.revision,
		name: row.name,
		email: row.email,
		accountNumber: null,
		address: FIXTURE_ADDRESS,
		status: row.status,
		rateCategory: row.rateCategory,
		agRenewalDate: row.agRenewalDate,
		...changes,
	} as CustomerInput & { id: string; expectedRevision: number };
}

async function jobsFor(customerId: string): Promise<JobRow[]> {
	const { rows } = await pool.query<JobRow>(
		`select id, job_type, status, run_at, attempts, last_error, bfa_asset_id,
		        customer_id, ag_renewal_date::text, water_purveyor_id,
		        provider_message_id, delivery_payload
		   from scheduled_jobs where customer_id = $1
		  order by created_at, id`,
		[customerId],
	);

	return rows;
}

function live(rows: JobRow[]) {
	return rows.filter((row) => ["pending", "running"].includes(row.status));
}

async function customerRow(customerId: string) {
	const { rows } = await pool.query<{
		name: string;
		ag_renewal_date: string | null;
		rate_category: string;
		status: string;
		revision: number;
		updated_at: Date;
	}>(
		"select name, ag_renewal_date::text, rate_category, status, revision, updated_at from customers where id = $1",
		[customerId],
	);

	return rows[0];
}

/** Claims the customer's one live renewal job, as the loop's claim would. */
async function claimRenewalJob(customerId: string) {
	const { rows } = await pool.query<{ id: string }>(
		`update scheduled_jobs set status = 'running'
		  where customer_id = $1 and job_type = 'ag_renewal' and status = 'pending'
		  returning id`,
		[customerId],
	);

	expect(rows).toHaveLength(1);

	const { scheduledJobs } = await import("@bfa-platform/db/schema");
	const { eq } = await import("drizzle-orm");
	const [job] = await db
		.select()
		.from(scheduledJobs)
		.where(eq(scheduledJobs.id, (rows[0] as { id: string }).id));

	if (!job) throw new Error("claimed job vanished");

	return job;
}

/** Makes the customer's pending renewal job due now. */
async function makeDue(customerId: string) {
	await pool.query(
		`update scheduled_jobs set run_at = now() - interval '1 second'
		  where customer_id = $1 and job_type = 'ag_renewal' and status = 'pending'`,
		[customerId],
	);
}

/**
 * The provider stand-in the other workflow suites use: honours the
 * idempotency contract — a repeated key returns the original id and sends
 * nothing, and a different body under the same key is refused.
 */
function fakeProvider() {
	const sent = new Map<string, { id: string; body: string; to: string }>();
	const calls: { key: string | undefined; to: string }[] = [];
	const state = {
		refuse: false,
		acceptThenLoseResponse: false,
		/**
		 * Runs once, inside the next send — after the handler's pre-send checks
		 * and before the provider's answer. The window a concurrent WP save
		 * would land in.
		 */
		onSend: null as null | (() => Promise<unknown>),
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

			const hook = state.onSend;
			state.onSend = null;
			if (hook) await hook();

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
			if (!previous) sent.set(key, { id, body, to: message.to });

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
		sentTo: (to: string) => [...sent.values()].filter((m) => m.to === to),
		bodies: () => [...sent.values()].map((m) => m.body),
	};
}

describeDb("Workflow 2 — AG rate renewal notice", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		({ db } = await import("@bfa-platform/db"));
		({
			runAgRenewalJob,
			AG_RENEWAL_CANCEL_REASONS,
			AG_RENEWAL_HOLD_REASONS,
			AG_RENEWAL_NO_SUCCESSOR_REASONS,
			reconcileAgRenewalNotice,
		} = await import("./ag-renewal"));
		({ scheduleAgRenewalJob } = await import("./jobs"));
		({ runSchedulerTick } = await import("./index"));
		honolulu = await import("../lib/honolulu-dates");

		const { t } = await import("../index");
		const { appRouter } = await import("../routers/index");
		const createCaller = t.createCallerFactory(appRouter);

		rawCallerFor = (profileId: string) =>
			createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as unknown as ReturnType<typeof rawCallerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Kalani Water Works', 'WF2-A', 'active'),
			        ($2, 'Kalani Water Works', 'WF2-B', 'active'),
			        ($3, 'Kalani Water Works', 'WF2-C', 'active')`,
			[wpA, wpB, wpC],
		);

		const profiles: [string, string][] = [
			[ids.adminA, wpA],
			[ids.adminB, wpB],
			[ids.adminC, wpC],
		];

		for (const [id, wp] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'WF2 Admin', 'wp_admin', 'active')`,
				[id, wp],
			);
		}

		await pool.query(
			`insert into wp_feature_flags (water_purveyor_id, feature, is_enabled)
			 values ($1, 'ag_renewal_notice', true),
			        ($2, 'ag_renewal_notice', false)`,
			[wpA, wpB],
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();

		// Whatever a test left queued is withdrawn, so the next test's tick sees
		// only its own work.
		await pool.query(
			`update scheduled_jobs set status = 'cancelled'
			  where status in ('pending', 'running') and water_purveyor_id = any($1::uuid[])`,
			[[wpA, wpB, wpC]],
		);
	});

	afterAll(async () => {
		if (!pool) return;

		const wps = [[wpA, wpB, wpC]];

		await pool.query(
			"delete from scheduled_jobs where water_purveyor_id = any($1::uuid[])",
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

	describe("scheduling on creation", () => {
		it("queues one customer-scoped job at midnight Honolulu on the renewal date", async () => {
			const lines = captureLogs();
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);

			const rows = await jobsFor(customer.id);
			expect(rows).toHaveLength(1);

			const [job] = rows;
			if (!job) throw new Error("no job was queued");

			expect(job).toMatchObject({
				job_type: "ag_renewal",
				status: "pending",
				customer_id: customer.id,
				ag_renewal_date: FUTURE_DAY,
				bfa_asset_id: null,
				water_purveyor_id: wpA,
				attempts: 0,
			});

			// Midnight in Hawaii is 10:00 UTC — never midnight UTC, which is 14:00
			// the previous day on the islands.
			expect(job.run_at.toISOString()).toBe(`${FUTURE_DAY}T10:00:00.000Z`);
			expect(job.run_at.getTime()).toBe(
				honolulu.honoluluDayStart(FUTURE_DAY).getTime(),
			);
			expect(honolulu.honoluluCalendarDay(job.run_at)).toBe(FUTURE_DAY);
			expect(
				honolulu.honoluluCalendarDay(new Date(job.run_at.getTime() - 1)),
			).toBe(honolulu.addCalendarDays(FUTURE_DAY, -1));

			const [scheduled] = eventsNamed(lines, "scheduler_job_scheduled");
			expect(scheduled).toMatchObject({
				job_type: "ag_renewal",
				customer_id: customer.id,
				wp_id: wpA,
				actor_id: ids.adminA,
				trigger: "customer_created",
				ag_renewal_date: FUTURE_DAY,
			});
		});

		it("queues nothing for a standard-rate customer", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer({
				name: "Standard Stan",
				email: `wf2-standard-${randomUUID().slice(0, 6)}@example.com`,
				rateCategory: "standard",
			});

			expect(await jobsFor(customer.id)).toEqual([]);
		});

		it("queues the job in the caller's own tenant, whatever the flag says", async () => {
			// The flag is read at run time, not at scheduling time, so switching the
			// add-on on later needs no backfill.
			const inB = await callerFor(ids.adminB).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			const inC = await callerFor(ids.adminC).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);

			expect((await jobsFor(inB.id)).map((j) => j.water_purveyor_id)).toEqual([
				wpB,
			]);
			expect((await jobsFor(inC.id)).map((j) => j.water_purveyor_id)).toEqual([
				wpC,
			]);
		});

		it("leaves no job behind when the customer insert fails", async () => {
			const first = agCustomer(FUTURE_DAY);
			await callerFor(ids.adminA).customers.createCustomer(first);

			const countJobs = async () => {
				const { rows } = await pool.query<{ n: number }>(
					"select count(*)::int as n from scheduled_jobs where water_purveyor_id = $1",
					[wpA],
				);
				return rows[0]?.n;
			};
			const before = await countJobs();

			// Same address in the same tenant: refused by the unique index, and the
			// transaction takes any job with it.
			await expect(
				callerFor(ids.adminA).customers.createCustomer(
					agCustomer(LATER_DAY, { email: first.email }),
				),
			).rejects.toMatchObject({ code: "CONFLICT" });

			expect(await countJobs()).toBe(before);
		});
	});

	describe("tenant isolation", () => {
		it("does not let another purveyor reschedule or cancel a customer's notice", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			const before = await jobsFor(customer.id);

			await expect(
				callerFor(ids.adminB).customers.updateCustomer(
					edit(customer, { agRenewalDate: LATER_DAY }),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				callerFor(ids.adminB).customers.updateCustomer(
					edit(customer, { rateCategory: "standard", agRenewalDate: null }),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });

			expect(await jobsFor(customer.id)).toEqual(before);
		});

		it("cancels a job whose customer is not in the job's purveyor, without sending", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			// A job row that names wpB but points at wpA's customer — a restore or
			// a hand-written row. It must never be mailed.
			await pool.query(
				"update scheduled_jobs set water_purveyor_id = $2 where customer_id = $1",
				[customer.id, wpB],
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({
				kind: "cancelled",
				reason: AG_RENEWAL_CANCEL_REASONS.customerGone,
			});
			expect(provider.calls).toHaveLength(0);
		});
	});

	describe("idempotency and concurrency", () => {
		it("creates one live job when two writers schedule the same customer at once", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			await pool.query(
				`update scheduled_jobs set status = 'cancelled' where customer_id = $1`,
				[customer.id],
			);

			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					scheduleAgRenewalJob({
						customerId: customer.id,
						waterPurveyorId: wpA,
						agRenewalDate: LATER_DAY,
					}),
				),
			);

			expect(results.filter(Boolean)).toHaveLength(1);
			const liveJobs = live(await jobsFor(customer.id));
			expect(liveJobs).toHaveLength(1);
			expect(liveJobs[0]).toMatchObject({ ag_renewal_date: LATER_DAY });
			expect(liveJobs[0]?.run_at.toISOString()).toBe(
				`${LATER_DAY}T10:00:00.000Z`,
			);
		});

		it("refuses a second live renewal job for one customer at the database", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);

			await expect(
				pool.query(
					`insert into scheduled_jobs (job_type, customer_id, water_purveyor_id, run_at, status)
					 values ('ag_renewal', $1, $2, now(), 'pending')`,
					[customer.id, wpA],
				),
			).rejects.toThrow(/scheduled_jobs_live_customer_job_type_key/);
		});

		it("reconciling twice to the same state writes nothing the second time", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			const before = await jobsFor(customer.id);
			const lines = captureLogs();

			await db.transaction((tx) =>
				reconcileAgRenewalNotice({
					executor: tx,
					customerId: customer.id,
					waterPurveyorId: wpA,
					rateCategory: "agricultural",
					agRenewalDate: FUTURE_DAY,
					trigger: "customer_updated",
				}),
			);

			expect(await jobsFor(customer.id)).toEqual(before);
			expect(lines).toEqual([]);
		});

		it("lets one of two simultaneous date edits win and refuses the other as stale", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);

			// Both forms were opened at revision 1. They serialise on the row, and
			// the second finds the version it was editing gone.
			const results = await Promise.allSettled([
				callerFor(ids.adminA).customers.updateCustomer(
					edit(customer, { agRenewalDate: LATER_DAY }),
				),
				callerFor(ids.adminA).customers.updateCustomer(
					edit(customer, { agRenewalDate: "2031-09-09" }),
				),
			]);

			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const [rejected] = results.filter(
				(result) => result.status === "rejected",
			);
			expect(
				(rejected as PromiseRejectedResult | undefined)?.reason,
			).toMatchObject({ code: "CONFLICT", message: CUSTOMER_STALE_MESSAGE });

			const stored = await customerRow(customer.id);
			const liveJobs = live(await jobsFor(customer.id));

			expect(stored?.revision).toBe(2);
			expect(liveJobs).toHaveLength(1);
			expect(liveJobs[0]).toMatchObject({
				ag_renewal_date: stored?.ag_renewal_date,
			});
			expect(liveJobs[0]?.run_at.getTime()).toBe(
				honolulu.honoluluDayStart(stored?.ag_renewal_date as string).getTime(),
			);
		});
	});

	describe("reconciliation on edit", () => {
		it("moves the notice to a changed renewal date, cancelling the old one", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			const [original] = await jobsFor(customer.id);

			const lines = captureLogs();
			await callerFor(ids.adminA).customers.updateCustomer(
				edit(customer, { agRenewalDate: LATER_DAY }),
			);

			const rows = await jobsFor(customer.id);
			const old = rows.find((row) => row.id === original?.id);
			const liveJobs = live(rows);

			expect(old).toMatchObject({
				status: "cancelled",
				last_error: AG_RENEWAL_CANCEL_REASONS.renewalDateChanged,
			});
			expect(liveJobs).toHaveLength(1);
			expect(liveJobs[0]?.id).not.toBe(original?.id);
			expect(liveJobs[0]?.run_at.toISOString()).toBe(
				`${LATER_DAY}T10:00:00.000Z`,
			);

			expect(eventsNamed(lines, "scheduler_job_cancelled")).toHaveLength(1);
			expect(eventsNamed(lines, "scheduler_job_scheduled")[0]).toMatchObject({
				trigger: "customer_updated",
				replaced_job_ids: [original?.id],
			});
		});

		it("leaves the job alone when an edit changes something else", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			const before = await jobsFor(customer.id);

			const lines = captureLogs();
			await callerFor(ids.adminA).customers.updateCustomer(
				edit(customer, { name: "Kahale Farms Renamed" }),
			);

			expect(await jobsFor(customer.id)).toEqual(before);
			expect(eventsNamed(lines, "customer_updated")).toHaveLength(1);
			expect(
				lines.filter((line) => String(line.event).startsWith("scheduler_")),
			).toEqual([]);
		});

		it("treats a save that changes nothing as a no-op, job included", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);
			const before = await jobsFor(customer.id);
			const stored = await customerRow(customer.id);

			const lines = captureLogs();
			await callerFor(ids.adminA).customers.updateCustomer(edit(customer));

			expect(await jobsFor(customer.id)).toEqual(before);
			expect((await customerRow(customer.id))?.updated_at).toEqual(
				stored?.updated_at,
			);
			// `caller_resolved` is the auth middleware's own line; nothing about the
			// customer or its schedule may be logged for a save that changed nothing.
			expect(
				lines.filter((line) =>
					/^(customer_|scheduler_)/.test(String(line.event)),
				),
			).toEqual([]);
		});

		it("cancels the notice, with a reason, when the customer leaves the agricultural rate", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(FUTURE_DAY),
			);

			const lines = captureLogs();
			await callerFor(ids.adminA).customers.updateCustomer(
				edit(customer, { rateCategory: "standard", agRenewalDate: null }),
			);

			const rows = await jobsFor(customer.id);
			expect(live(rows)).toEqual([]);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				status: "cancelled",
				last_error: AG_RENEWAL_CANCEL_REASONS.notAgricultural,
			});
			expect(eventsNamed(lines, "scheduler_job_cancelled")[0]).toMatchObject({
				customer_id: customer.id,
				actor_id: ids.adminA,
				reason: AG_RENEWAL_CANCEL_REASONS.notAgricultural,
			});
		});

		it("queues a fresh notice when a standard customer moves onto the agricultural rate", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer({
				name: "Converted Farms",
				email: `wf2-converted-${randomUUID().slice(0, 6)}@example.com`,
				rateCategory: "standard",
			});

			await callerFor(ids.adminA).customers.updateCustomer(
				edit(customer, {
					rateCategory: "agricultural",
					agRenewalDate: FUTURE_DAY,
				}),
			);

			const liveJobs = live(await jobsFor(customer.id));
			expect(liveJobs).toHaveLength(1);
			expect(liveJobs[0]?.run_at.toISOString()).toBe(
				`${FUTURE_DAY}T10:00:00.000Z`,
			);
		});

		it("withdraws a running job on a date change, so a send racing it is not completed", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);

			await callerFor(ids.adminA).customers.updateCustomer(
				edit(customer, { agRenewalDate: FUTURE_DAY }),
			);

			const provider = fakeProvider();
			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({ kind: "superseded" });
			expect(provider.calls).toHaveLength(0);

			// The WP's date stands, and the only live job is the one for it.
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(
				FUTURE_DAY,
			);
			const liveJobs = live(await jobsFor(customer.id));
			expect(liveJobs).toHaveLength(1);
			expect(liveJobs[0]).toMatchObject({ ag_renewal_date: FUTURE_DAY });
		});

		it("cancels, unsent, a job whose customer's date was changed outside the procedures", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			await pool.query(
				"update customers set ag_renewal_date = $2 where id = $1",
				[customer.id, FUTURE_DAY],
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({
				kind: "cancelled",
				reason: AG_RENEWAL_CANCEL_REASONS.staleRenewalDate,
			});
			expect(provider.calls).toHaveLength(0);
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(
				FUTURE_DAY,
			);
		});
	});

	describe("the run-time feature gate", () => {
		it("cancels without sending, or spending an attempt, when the flag is off", async () => {
			const customer = await callerFor(ids.adminB).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({
				kind: "cancelled",
				reason: AG_RENEWAL_CANCEL_REASONS.featureDisabled,
			});
			expect(provider.calls).toHaveLength(0);

			const [row] = await jobsFor(customer.id);
			expect(row).toMatchObject({
				status: "cancelled",
				attempts: 0,
				provider_message_id: null,
				delivery_payload: null,
				last_error: AG_RENEWAL_CANCEL_REASONS.featureDisabled,
			});
			expect(await jobsFor(customer.id)).toHaveLength(1);
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(PAST_DAY);
		});

		it("treats a missing flag row as off", async () => {
			const customer = await callerFor(ids.adminC).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const provider = fakeProvider();

			await runSchedulerTick({ driver: provider.driver });

			expect(provider.sentTo(customer.email)).toHaveLength(0);
			expect(await jobsFor(customer.id)).toHaveLength(1);
			expect((await jobsFor(customer.id))[0]).toMatchObject({
				status: "cancelled",
				attempts: 0,
				last_error: AG_RENEWAL_CANCEL_REASONS.featureDisabled,
			});
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(PAST_DAY);
		});
	});

	describe("delivery", () => {
		it("sends to the customer's own email, whatever assets they are or are not attached to", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const occupant = await callerFor(ids.adminA).customers.createCustomer({
				name: "Current Occupant",
				email: `wf2-occupant-${randomUUID().slice(0, 6)}@example.com`,
				rateCategory: "standard",
			});

			// An asset the AG customer once occupied, now pointing at somebody
			// else. An asset notice would go to the occupant; this must not.
			const assetId = randomUUID();
			await pool.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, current_customer_id, bfa_type, service_address)
				 values ($1, $2, $3, $4, 'RP', '9 Field Road')`,
				[assetId, wpA, `WF2-${randomUUID().slice(0, 8)}`, occupant.id],
			);
			await pool.query(
				`insert into customer_assignments (bfa_asset_id, customer_id, start_date, end_date)
				 values ($1, $2, '2025-01-01', '2025-12-31'), ($1, $3, '2026-01-01', null)`,
				[assetId, customer.id, occupant.id],
			);

			const provider = fakeProvider();
			await runSchedulerTick({ driver: provider.driver });

			expect(provider.sentTo(customer.email)).toHaveLength(1);
			expect(provider.sentTo(occupant.email)).toHaveLength(0);

			const [message] = provider.sentTo(customer.email);
			const body = JSON.parse(message?.body ?? "{}");
			expect(body.subject).toContain(PAST_DAY);
			expect(body.html).toContain(customer.name);
			expect(body.html).toContain("Kalani Water Works");
			expect(body.tags).toEqual([
				{ name: "type", value: "ag_renewal" },
				{ name: "wp_id", value: wpA },
				{ name: "customer_id", value: customer.id },
			]);
		});

		it("completes and moves the date one year past the delivery day, with exactly one next job", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const before = await customerRow(customer.id);
			const [original] = await jobsFor(customer.id);
			const provider = fakeProvider();

			const lines = captureLogs();
			const tick = await runSchedulerTick({ driver: provider.driver });

			// The scheduler handles the type: nothing is deferred as unhandled.
			expect(tick.unhandled).toBe(0);
			expect(tick.sent).toBeGreaterThanOrEqual(1);
			expect(provider.sentTo(customer.email)).toHaveLength(1);

			const rows = await jobsFor(customer.id);
			expect(rows).toHaveLength(2);

			const [done, next] = rows;
			expect(done).toMatchObject({
				id: original?.id,
				status: "completed",
				attempts: 0,
				last_error: null,
				delivery_payload: null,
				ag_renewal_date: PAST_DAY,
			});
			expect(done?.provider_message_id).toMatch(/^re_/);

			// Exactly one successor: pending, a year after the Hawaii day this
			// delivery was confirmed on — not a year after the notice's own date,
			// which was three days ago — at midnight Pacific/Honolulu (10:00 UTC).
			// A fresh row, so a fresh idempotency key.
			const expectedNext = nextYearFromToday();
			expect(expectedNext).not.toBe(addCalendarYears(PAST_DAY, 1));
			expect(next).toMatchObject({
				status: "pending",
				job_type: "ag_renewal",
				customer_id: customer.id,
				bfa_asset_id: null,
				water_purveyor_id: wpA,
				ag_renewal_date: expectedNext,
				attempts: 0,
				provider_message_id: null,
				delivery_payload: null,
			});
			expect(next?.run_at.toISOString()).toBe(`${expectedNext}T10:00:00.000Z`);

			const after = await customerRow(customer.id);
			expect(after?.ag_renewal_date).toBe(expectedNext);
			expect(after?.updated_at.getTime()).toBeGreaterThan(
				before?.updated_at.getTime() ?? 0,
			);
			// One real change to the row, so one revision — which is what makes a
			// form opened before this transition a stale save rather than a silent
			// overwrite.
			expect(after?.revision).toBe((before?.revision ?? 0) + 1);

			const completed = eventsNamed(lines, "scheduler_job_completed").filter(
				(line) => line.job_id === done?.id,
			);
			expect(completed).toHaveLength(1);
			expect(completed[0]).toMatchObject({
				customer_id: customer.id,
				delivery_pass: "first_attempt",
				previous_ag_renewal_date: PAST_DAY,
				next_ag_renewal_date: expectedNext,
				next_job_id: next?.id,
				no_successor_reason: null,
			});
			// Identifiers and dates only — never the address or the message.
			expect(JSON.stringify(completed[0])).not.toContain(customer.email);
			expect(JSON.stringify(completed[0])).not.toContain("html");
			expect(
				eventsNamed(lines, "scheduler_job_scheduled").find(
					(line) => line.job_id === next?.id,
				),
			).toMatchObject({
				trigger: "ag_renewal_annual_cycle",
				ag_renewal_date: expectedNext,
				previous_job_id: done?.id,
			});

			// A second tick sends nothing more and adds no year: the completed job
			// is not claimable, and next year's is not due.
			await runSchedulerTick({ driver: provider.driver });
			expect(provider.sentTo(customer.email)).toHaveLength(1);
			expect(await jobsFor(customer.id)).toHaveLength(2);
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: expectedNext,
				revision: (before?.revision ?? 0) + 1,
			});
		});

		it("turns a 29 February delivery into 28 February in the next, non-leap year", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				// The notice's own date is beside the point: the year is counted
				// from the day the delivery is confirmed on.
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			// 20:00 UTC on 29 February 2028 is 10:00 that same morning in Hawaii —
			// an explicit instant, so this case never depends on the wall clock.
			const confirmedAt = new Date("2028-02-29T20:00:00.000Z");
			expect(honolulu.honoluluCalendarDay(confirmedAt)).toBe("2028-02-29");

			const outcome = await runAgRenewalJob(job, {
				driver: provider.driver,
				now: confirmedAt,
			});

			expect(outcome).toMatchObject({
				kind: "sent",
				nextRenewalDate: "2029-02-28",
			});
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(
				"2029-02-28",
			);

			const liveJobs = live(await jobsFor(customer.id));
			expect(liveJobs).toHaveLength(1);
			expect(liveJobs[0]).toMatchObject({ ag_renewal_date: "2029-02-28" });
			expect(liveJobs[0]?.run_at.toISOString()).toBe(
				"2029-02-28T10:00:00.000Z",
			);
		});

		it("puts a long-overdue notice a year after today, not a year after its own date", async () => {
			// A renewal date entered more than two years late. Counting from the
			// job's own date would queue a successor that is itself already
			// overdue, and it would fire on the very next tick.
			const old = addCalendarYears(addCalendarDays(honoluluToday(), -1), -2);
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(old),
			);
			const provider = fakeProvider();

			await runSchedulerTick({ driver: provider.driver });
			// A second tick must find nothing due: no second email, no second year.
			await runSchedulerTick({ driver: provider.driver });

			expect(provider.sentTo(customer.email)).toHaveLength(1);

			const expectedNext = nextYearFromToday();
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: expectedNext,
				revision: 2,
			});
			expect(live(await jobsFor(customer.id))).toMatchObject([
				{ ag_renewal_date: expectedNext },
			]);
			expect(await jobsFor(customer.id)).toHaveLength(2);
		});

		it("replays the frozen payload under the same key when the first answer is lost", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const provider = fakeProvider();

			provider.state.acceptThenLoseResponse = true;
			const first = await runSchedulerTick({ driver: provider.driver });
			expect(first.retrying).toBeGreaterThanOrEqual(1);

			const [pending] = await jobsFor(customer.id);
			expect(pending).toMatchObject({
				status: "pending",
				attempts: 1,
				provider_message_id: null,
			});
			expect(pending?.delivery_payload).toMatchObject({
				to: customer.email,
				recipientId: customer.id,
			});

			// The sender changes between attempts; the replay must still send the
			// frozen body, or the provider would refuse the key.
			provider.state.acceptThenLoseResponse = false;
			provider.state.sender = {
				from: "Changed <changed@kalani.example>",
				replyTo: "changed@kalani.example",
			};
			await makeDue(customer.id);

			const lines = captureLogs();
			await runSchedulerTick({ driver: provider.driver });

			const keys = provider.calls
				.filter((call) => call.to === customer.email)
				.map((call) => call.key);
			expect(keys).toHaveLength(2);
			expect(new Set(keys).size).toBe(1);
			expect(keys[0]).toBe(`bfa-notice/${pending?.id}`);
			expect(provider.sentTo(customer.email)).toHaveLength(1);

			const [done, next, ...rest] = await jobsFor(customer.id);
			expect(done).toMatchObject({ status: "completed", attempts: 1 });
			expect(
				eventsNamed(lines, "scheduler_job_completed").find(
					(line) => line.job_id === done?.id,
				),
			).toMatchObject({
				delivery_pass: "idempotent_retry",
				next_ag_renewal_date: nextYearFromToday(),
			});

			// The lost answer moved nothing; the confirmed one moved it once —
			// one successor, one revision.
			expect(next).toMatchObject({
				status: "pending",
				ag_renewal_date: nextYearFromToday(),
			});
			expect(rest).toEqual([]);
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: nextYearFromToday(),
				revision: 2,
			});
		});

		it("moves nothing while the provider's answer is lost", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const provider = fakeProvider();
			provider.state.acceptThenLoseResponse = true;

			await runSchedulerTick({ driver: provider.driver });

			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: PAST_DAY,
				revision: 1,
			});
			expect(await jobsFor(customer.id)).toMatchObject([
				{ status: "pending", attempts: 1, provider_message_id: null },
			]);
		});

		it("dates the next notice from the recorded delivery, not from when recovery runs", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);

			// The provider confirmed at 20:00 UTC on 15 June 2027 — 10:00 that
			// morning in Hawaii. The process then died before the transition.
			const deliveredAt = new Date("2027-06-15T20:00:00.000Z");
			// Recovery runs the next Hawaii day. Dating the successor from this
			// clock instead of from the delivery would put it a day out.
			const recoveredAt = new Date("2027-06-16T20:00:00.000Z");
			expect(honolulu.honoluluCalendarDay(deliveredAt)).toBe("2027-06-15");
			expect(honolulu.honoluluCalendarDay(recoveredAt)).toBe("2027-06-16");

			await pool.query(
				`update scheduled_jobs
				    set provider_message_id = 're_fixed_day', delivered_at = $2,
				        delivery_attempted_at = $2
				  where id = $1`,
				[job.id, deliveredAt.toISOString()],
			);
			const provider = fakeProvider();

			const outcome = await runAgRenewalJob(job, {
				driver: provider.driver,
				now: recoveredAt,
			});

			// Recovery sends nothing: the delivery is already on record.
			expect(provider.calls).toHaveLength(0);
			expect(outcome).toMatchObject({
				kind: "sent",
				deliveryPass: "already_recorded",
				providerMessageId: "re_fixed_day",
				nextRenewalDate: "2028-06-15",
			});

			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: "2028-06-15",
				revision: 2,
			});

			const rows = await jobsFor(customer.id);
			expect(rows).toHaveLength(2);
			expect(live(rows)).toMatchObject([{ ag_renewal_date: "2028-06-15" }]);
			expect(live(rows)[0]?.run_at.toISOString()).toBe(
				"2028-06-15T10:00:00.000Z",
			);
		});

		it("completes without a successor when a confirmed delivery has no recorded time", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);

			// `recordDelivery` writes the id and the time together, so this row
			// cannot come from the code — and if it ever did, the date must not be
			// guessed from a clock.
			await pool.query(
				`update scheduled_jobs
				    set provider_message_id = 're_no_time', delivered_at = null,
				        delivery_attempted_at = now()
				  where id = $1`,
				[job.id],
			);
			const provider = fakeProvider();

			const lines = captureLogs();
			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toMatchObject({ kind: "sent", nextRenewalDate: null });
			expect(provider.calls).toHaveLength(0);
			// The email went out, so the job completes — but nothing is dated from
			// a guess: the date and the revision stand, and no successor exists.
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: PAST_DAY,
				revision: 1,
			});
			expect(await jobsFor(customer.id)).toMatchObject([
				{ status: "completed" },
			]);
			expect(
				eventsNamed(lines, "scheduler_job_completed").find(
					(line) => line.job_id === job.id,
				),
			).toMatchObject({
				next_ag_renewal_date: null,
				next_job_id: null,
				no_successor_reason:
					AG_RENEWAL_NO_SUCCESSOR_REASONS.deliveryTimeUnknown,
			});
		});

		it("finishes the transition exactly once when the delivery was recorded but the pass died", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);

			// The state a crash leaves between `recordDelivery` and the transition:
			// the provider's id is on record, the job is still running.
			await pool.query(
				`update scheduled_jobs
				    set provider_message_id = 're_recorded', delivered_at = now(),
				        delivery_attempted_at = now()
				  where id = $1`,
				[job.id],
			);
			const provider = fakeProvider();

			const first = await runAgRenewalJob(job, { driver: provider.driver });
			// The same stale claim run again, as a recovered process would.
			const second = await runAgRenewalJob(job, { driver: provider.driver });

			expect(first).toMatchObject({
				kind: "sent",
				deliveryPass: "already_recorded",
				providerMessageId: "re_recorded",
				nextRenewalDate: nextYearFromToday(),
			});
			expect(second).toEqual({ kind: "superseded" });
			expect(provider.calls).toHaveLength(0);
			// The second pass finished nothing: one year, one revision, one job.
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: nextYearFromToday(),
				revision: 2,
			});
			expect(live(await jobsFor(customer.id))).toHaveLength(1);
		});

		it("adds one year and one revision, not two, when two handlers run the same claimed job at once", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			const outcomes = await Promise.all([
				runAgRenewalJob(job, { driver: provider.driver }),
				runAgRenewalJob(job, { driver: provider.driver }),
			]);

			expect(outcomes.filter((o) => o.kind === "sent")).toHaveLength(1);
			expect(outcomes.filter((o) => o.kind === "superseded")).toHaveLength(1);
			expect(provider.sentTo(customer.email)).toHaveLength(1);
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: nextYearFromToday(),
				revision: 2,
			});
			expect(live(await jobsFor(customer.id))).toMatchObject([
				{ ag_renewal_date: nextYearFromToday() },
			]);
		});

		it("holds, without spending an attempt, while the customer is suspended", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY, { status: "suspended" }),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({
				kind: "held",
				reason: AG_RENEWAL_HOLD_REASONS.suspendedCustomer,
			});
			expect(provider.calls).toHaveLength(0);
			expect(await jobsFor(customer.id)).toMatchObject([
				{ status: "pending", attempts: 0, provider_message_id: null },
			]);
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(PAST_DAY);
		});

		it("holds, without spending an attempt, while the water purveyor is blocked", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			await pool.query(
				"update water_purveyors set status = 'blocked' where id = $1",
				[wpA],
			);
			try {
				const outcome = await runAgRenewalJob(job, { driver: provider.driver });

				expect(outcome).toEqual({
					kind: "held",
					reason: AG_RENEWAL_HOLD_REASONS.blockedPurveyor,
				});
				expect(provider.calls).toHaveLength(0);
				expect(await jobsFor(customer.id)).toMatchObject([
					{ status: "pending", attempts: 0, provider_message_id: null },
				]);
			} finally {
				await pool.query(
					"update water_purveyors set status = 'active' where id = $1",
					[wpA],
				);
			}
		});

		it("cancels at run time if the customer left the agricultural rate outside the procedures", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			await pool.query(
				`update customers set rate_category = 'standard', ag_renewal_date = null where id = $1`,
				[customer.id],
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({
				kind: "cancelled",
				reason: AG_RENEWAL_CANCEL_REASONS.notAgricultural,
			});
			expect(provider.calls).toHaveLength(0);
		});
	});

	describe("a WP save racing the send", () => {
		it("keeps the WP's new date and its job when the date changes mid-send", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();
			provider.state.onSend = () =>
				callerFor(ids.adminA).customers.updateCustomer(
					edit(customer, { agRenewalDate: LATER_DAY }),
				);

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			// The email went out, but the job was withdrawn under it: no year is
			// added on top of the WP's date, and no successor from the old one.
			expect(outcome).toEqual({ kind: "superseded" });
			expect(provider.sentTo(customer.email)).toHaveLength(1);
			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(LATER_DAY);
			expect(live(await jobsFor(customer.id))).toMatchObject([
				{ ag_renewal_date: LATER_DAY },
			]);
		});

		it("queues nothing when the customer leaves the agricultural rate mid-send", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();
			provider.state.onSend = () =>
				callerFor(ids.adminA).customers.updateCustomer(
					edit(customer, { rateCategory: "standard", agRenewalDate: null }),
				);

			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			expect(outcome).toEqual({ kind: "superseded" });
			const after = await customerRow(customer.id);
			expect(after).toMatchObject({
				rate_category: "standard",
				ag_renewal_date: null,
			});
			expect(live(await jobsFor(customer.id))).toEqual([]);
		});

		it("completes without moving the date when the customer is suspended mid-send", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const job = await claimRenewalJob(customer.id);
			const provider = fakeProvider();
			provider.state.onSend = () =>
				callerFor(ids.adminA).customers.updateCustomer(
					edit(customer, { status: "suspended" }),
				);

			const lines = captureLogs();
			const outcome = await runAgRenewalJob(job, { driver: provider.driver });

			// The email is a fact, so the job completes — but a customer who is not
			// active does not get a next year.
			expect(outcome).toMatchObject({ kind: "sent", nextRenewalDate: null });
			expect(await customerRow(customer.id)).toMatchObject({
				status: "suspended",
				ag_renewal_date: PAST_DAY,
				// Bumped by the WP's own save and by nothing else: the transition
				// wrote no row at all.
				revision: 2,
			});
			expect(await jobsFor(customer.id)).toMatchObject([
				{ status: "completed" },
			]);
			expect(
				eventsNamed(lines, "scheduler_job_completed").find(
					(line) => line.job_id === job.id,
				),
			).toMatchObject({
				previous_ag_renewal_date: PAST_DAY,
				next_ag_renewal_date: null,
				next_job_id: null,
				no_successor_reason: AG_RENEWAL_NO_SUCCESSOR_REASONS.notActive,
			});
		});

		it("refuses a form opened before the annual transition, keeping the new date and its successor", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const provider = fakeProvider();
			await runSchedulerTick({ driver: provider.driver });

			const moved = await customerRow(customer.id);
			const successor = live(await jobsFor(customer.id));

			// The clerk opened this form before tonight's transition, so it still
			// carries revision 1 and the old renewal date. Without the revision
			// check this save would look like a deliberate date change: it would
			// cancel the fresh successor and queue a job for a day already past —
			// a second email to the same customer.
			await expect(
				callerFor(ids.adminA).customers.updateCustomer(
					edit(customer, { name: "Renamed From A Stale Form" }),
				),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: CUSTOMER_STALE_MESSAGE,
			});

			// Nothing rolled back, and nothing was queued for the old date.
			expect(await customerRow(customer.id)).toMatchObject({
				ag_renewal_date: nextYearFromToday(),
				revision: moved?.revision,
				name: customer.name,
			});
			expect(live(await jobsFor(customer.id))).toEqual(successor);
			expect(provider.sentTo(customer.email)).toHaveLength(1);
		});

		it("lets a WP that reloaded the record change the date after the transition", async () => {
			const customer = await callerFor(ids.adminA).customers.createCustomer(
				agCustomer(PAST_DAY),
			);
			const provider = fakeProvider();
			await runSchedulerTick({ driver: provider.driver });

			// Reopening the form is what the conflict above tells the clerk to do,
			// and from the current revision the edit goes through cleanly: their
			// date replaces the scheduler's, with one live job for it.
			const reloaded = await customerRow(customer.id);
			await callerFor(ids.adminA).customers.updateCustomer({
				...edit(customer, { agRenewalDate: LATER_DAY }),
				expectedRevision: reloaded?.revision as number,
			});

			expect((await customerRow(customer.id))?.ag_renewal_date).toBe(LATER_DAY);
			expect(live(await jobsFor(customer.id))).toMatchObject([
				{ ag_renewal_date: LATER_DAY },
			]);
		});
	});
});
