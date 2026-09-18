import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `scheduled_jobs` policies added in
 * `0012_scheduled_job_policies`.
 *
 * Same shape as `notice-templates-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, which is how a request arrives through PostgREST. The scheduler reads
 * and writes through the service-role connection, which bypasses RLS entirely,
 * so nothing in the application would notice these policies break — which is
 * exactly why they need their own suite.
 *
 * The table is read-only for every signed-in role. There is no INSERT, UPDATE or
 * DELETE grant at all, which is a stronger statement than a narrow policy: a job
 * row records what the platform did or is about to do on a purveyor's behalf, and
 * a user editing one would be editing the record of their own mail. The write
 * tests below therefore assert a *privilege* failure, not a policy one.
 *
 * Two purveyors are seeded with interchangeable jobs — same type, same run time
 * — so a leak looks like a leak rather than like a plausible row.
 *
 * Opt-in: this suite writes to a real database, so it runs only under
 * `npm run test:db`. Every statement runs inside a transaction that is rolled
 * back, so no test writes survive itself.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wpA = randomUUID();
const wpB = randomUUID();
const ids = {
	superAdmin: randomUUID(),
	adminA: randomUUID(),
	subAdminA: randomUUID(),
	employeeA: randomUUID(),
	adminB: randomUUID(),
	certifierProfile: randomUUID(),
	blockedAdminA: randomUUID(),
};
const certifierId = randomUUID();
const assetA = randomUUID();
const assetB = randomUUID();
const jobA = randomUUID();
const jobB = randomUUID();
const submissionA = randomUUID();
const submissionB = randomUUID();
const failureJobA = randomUUID();
const failureJobB = randomUUID();

let pool: pg.Pool;

/** Runs `fn` as the given profile, then throws the whole transaction away. */
async function asUser<T>(
	profileId: string,
	fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();

	try {
		await client.query("begin");
		await client.query("select set_config('request.jwt.claims', $1, true)", [
			JSON.stringify({ sub: profileId, role: "authenticated" }),
		]);
		await client.query("set local role authenticated");

		return await fn(client);
	} finally {
		await client.query("rollback").catch(() => undefined);
		client.release();
	}
}

async function rowsFor(profileId: string, sql: string, params: unknown[] = []) {
	return asUser(profileId, async (client) => {
		const result = await client.query(sql, params);
		return result.rows;
	});
}

const selectJobs = "select id, water_purveyor_id from scheduled_jobs";

describeDb("RLS — scheduled_jobs", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Job RLS Water Works', 'JOB-RLS-A', 'active'),
				        ($2, 'Job RLS Water Works', 'JOB-RLS-B', 'active')`,
				[wpA, wpB],
			);

			const profiles: [string, string | null, string][] = [
				[ids.superAdmin, null, "super_admin"],
				[ids.adminA, wpA, "wp_admin"],
				[ids.subAdminA, wpA, "wp_sub_admin"],
				[ids.employeeA, wpA, "wp_employee"],
				[ids.adminB, wpB, "wp_admin"],
				[ids.certifierProfile, null, "certifier"],
				[ids.blockedAdminA, wpA, "wp_admin"],
			];

			for (const [id, wp, role] of profiles) {
				await client.query(
					`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
					 values ($1, $2, 'Job RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			// A certifier authorized for wpA, so "a certifier sees nothing" is a
			// statement about the policy rather than about an unrelated account.
			await client.query(
				`insert into certifiers (id, profile_id, company, id_number, status)
				 values ($1, $2, 'Job RLS Testing', 'JOB-RLS-1', 'active')`,
				[certifierId, ids.certifierProfile],
			);
			await client.query(
				`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
				 values ($1, $2, 'active')`,
				[certifierId, wpA],
			);

			await client.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date)
				 values ($1, $2, 'JOB-RLS-BIN', 'RP', '1 Shared Way', '2027-01-15'),
				        ($3, $4, 'JOB-RLS-BIN', 'RP', '1 Shared Way', '2027-01-15')`,
				[assetA, wpA, assetB, wpB],
			);

			// Same stage, same run time, two tenants.
			await client.query(
				`insert into scheduled_jobs (id, job_type, bfa_asset_id, water_purveyor_id, run_at, status)
				 values ($1, 'reminder', $2, $3, '2026-11-15T10:00:00Z', 'pending'),
				        ($4, 'reminder', $5, $6, '2026-11-15T10:00:00Z', 'pending')`,
				[jobA, assetA, wpA, jobB, assetB, wpB],
			);

			// A submitted failing test per tenant, and the failure-notice job
			// answering it (0016): submission-scoped, no asset on the row. The new
			// column rides on 0012's table-level SELECT, and these rows prove the
			// same tenancy story holds for it.
			await client.query(
				`insert into test_submissions (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type, wizard_data, test_result)
				 values ($1, $2, $3, $4, 'submitted', 'RP', '{}'::jsonb, 'fail'),
				        ($5, $6, $3, $7, 'submitted', 'RP', '{}'::jsonb, 'fail')`,
				[submissionA, assetA, certifierId, wpA, submissionB, assetB, wpB],
			);
			await client.query(
				`insert into scheduled_jobs (id, job_type, test_submission_id, water_purveyor_id, run_at, status)
				 values ($1, 'failure_notice', $2, $3, '2026-11-15T10:00:00Z', 'pending'),
				        ($4, 'failure_notice', $5, $6, '2026-11-15T10:00:00Z', 'pending')`,
				[failureJobA, submissionA, wpA, failureJobB, submissionB, wpB],
			);

			await client.query("commit");
		} catch (error) {
			await client.query("rollback").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query("delete from scheduled_jobs where id = any($1::uuid[])", [
			[jobA, jobB, failureJobA, failureJobB],
		]);
		await pool.query(
			"delete from test_submissions where id = any($1::uuid[])",
			[[submissionA, submissionB]],
		);
		await pool.query("delete from bfa_assets where id = any($1::uuid[])", [
			[assetA, assetB],
		]);
		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id = $1",
			[certifierId],
		);
		await pool.query("delete from certifiers where id = $1", [certifierId]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB],
		]);
		await pool.end();
	});

	describe("reading", () => {
		it("shows a Super-Admin every tenant's jobs", async () => {
			const rows = await rowsFor(ids.superAdmin, selectJobs);
			const seen = rows.map((row) => row.id);

			expect(seen).toContain(jobA);
			expect(seen).toContain(jobB);
		});

		it("shows each WP role only its own purveyor's jobs", async () => {
			for (const profileId of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(profileId, selectJobs);
				const seen = rows.map((row) => row.id);

				expect(seen).toContain(jobA);
				expect(seen).not.toContain(jobB);
			}
		});

		it("shows a WP its own failure notice — with the submission it answers — and not the neighbour's", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id, test_submission_id from scheduled_jobs where job_type = 'failure_notice'",
			);

			expect(rows).toEqual([
				{ id: failureJobA, test_submission_id: submissionA },
			]);
		});

		it("does not let a WP read another purveyor's job by naming its id", async () => {
			const rows = await rowsFor(ids.adminA, `${selectJobs} where id = $1`, [
				jobB,
			]);

			// Not an error — no row. A refusal that distinguished "forbidden" from
			// "does not exist" would confirm the row exists somewhere, which is what
			// a cross-tenant probe is looking for.
			expect(rows).toEqual([]);
		});

		it("shows a certifier nothing, even for a purveyor they work for", async () => {
			const rows = await rowsFor(ids.certifierProfile, selectJobs);

			expect(rows).toEqual([]);
		});

		it("shows a blocked WP Admin nothing", async () => {
			const rows = await rowsFor(ids.blockedAdminA, selectJobs);

			expect(rows).toEqual([]);
		});
	});

	describe("writing", () => {
		it("refuses an insert from a WP Admin, for want of the privilege", async () => {
			await expect(
				rowsFor(
					ids.adminA,
					`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
					 values ('reminder', $1, $2, now(), 'pending') returning id`,
					[assetA, wpA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("refuses an insert from a Super-Admin too", async () => {
			await expect(
				rowsFor(
					ids.superAdmin,
					`insert into scheduled_jobs (job_type, bfa_asset_id, water_purveyor_id, run_at, status)
					 values ('reminder', $1, $2, now(), 'pending') returning id`,
					[assetA, wpA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("refuses an update to a WP's own job", async () => {
			await expect(
				rowsFor(
					ids.adminA,
					"update scheduled_jobs set status = 'cancelled' where id = $1 returning id",
					[jobA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("refuses a delete, including from a Super-Admin", async () => {
			for (const profileId of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						profileId,
						"delete from scheduled_jobs where id = $1 returning id",
						[jobA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});
});
