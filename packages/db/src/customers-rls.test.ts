import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `customers` policies added in
 * `0003_customer_policies`.
 *
 * Same shape as `rls.test.ts`: every statement runs as the `authenticated`
 * Postgres role with `request.jwt.claims` set to a fixture profile, which is
 * how a request arrives from PostgREST. The application reads through a
 * privileged connection that bypasses RLS, so nothing in the app would notice
 * these policies break — which is exactly why they need their own suite.
 *
 * Two purveyors are seeded with interchangeable customers, so a leak looks like
 * a leak rather than like a plausible row.
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
	certifier: randomUUID(),
	blockedAdminA: randomUUID(),
};
const customerA = randomUUID();
const customerB = randomUUID();

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

const insertCustomer = `insert into customers (water_purveyor_id, name, email, rate_category, status)
	 values ($1, $2, 'policy.write@example.com', 'standard', 'active') returning id`;

describeDb("RLS — customers", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Customer RLS Water Works', 'CUST-RLS-A', 'active'),
				        ($2, 'Customer RLS Water Works', 'CUST-RLS-B', 'active')`,
				[wpA, wpB],
			);

			const profiles: [string, string | null, string][] = [
				[ids.superAdmin, null, "super_admin"],
				[ids.adminA, wpA, "wp_admin"],
				[ids.subAdminA, wpA, "wp_sub_admin"],
				[ids.employeeA, wpA, "wp_employee"],
				[ids.adminB, wpB, "wp_admin"],
				[ids.certifier, null, "certifier"],
				[ids.blockedAdminA, wpA, "wp_admin"],
			];

			for (const [id, wp, role] of profiles) {
				await client.query(
					`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
					 values ($1, $2, 'Customer RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			await client.query(
				`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
				 values ($1, $2, 'Shared Name Holdings', 'shared@example.com', 'standard', 'active'),
				        ($3, $4, 'Shared Name Holdings', 'shared@example.com', 'standard', 'active')`,
				[customerA, wpA, customerB, wpB],
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

		const client = await pool.connect();
		try {
			await client.query(
				"delete from customers where water_purveyor_id = any($1::uuid[])",
				[[wpA, wpB]],
			);
			await client.query("delete from profiles where id = any($1::uuid[])", [
				Object.values(ids),
			]);
			await client.query(
				"delete from water_purveyors where id = any($1::uuid[])",
				[[wpA, wpB]],
			);
		} finally {
			client.release();
			await pool.end();
		}
	});

	describe("reads", () => {
		it("shows every WP role only their own purveyor's customers", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(reader, "select id from customers");

				expect(rows.map((row) => row.id)).toEqual([customerA]);
			}
		});

		it("returns nothing when a WP role names the other tenant's row directly", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from customers where id = $1",
				[customerB],
			);

			expect(rows).toHaveLength(0);
		});

		it("hides customers from a certifier entirely", async () => {
			// The build plan's certifier read path — customers reachable through an
			// authorized asset, for wizard prefill — is deliberately not in this
			// migration. Until the wizard needs it, the table is invisible to them.
			const rows = await rowsFor(ids.certifier, "select id from customers");

			expect(rows).toHaveLength(0);
		});

		it("shows both tenants to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from customers where id = any($1::uuid[])",
				[[customerA, customerB]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual(
				[customerA, customerB].sort(),
			);
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(ids.blockedAdminA, "select id from customers");

			expect(rows).toHaveLength(0);
		});
	});

	describe("writes", () => {
		it("lets every WP role add a customer to their own purveyor", async () => {
			for (const writer of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(writer, insertCustomer, [
					wpA,
					"Policy Insert",
				]);

				expect(rows).toHaveLength(1);
			}
		});

		it("refuses a WP role writing a customer into the other tenant", async () => {
			await expect(
				rowsFor(ids.employeeA, insertCustomer, [wpB, "Cross Tenant Insert"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a certifier writing a customer at all", async () => {
			await expect(
				rowsFor(ids.certifier, insertCustomer, [wpA, "Certifier Insert"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("lets a WP role suspend their own customer", async () => {
			const rows = await rowsFor(
				ids.employeeA,
				"update customers set status = 'suspended' where id = $1 returning status",
				[customerA],
			);

			expect(rows).toEqual([{ status: "suspended" }]);
		});

		it("refuses a WP role updating the other tenant's customer", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update customers set status = 'suspended' where id = $1 returning id",
				[customerB],
			);

			// The row is invisible under USING, so the update matches nothing rather
			// than raising — a silent no-op is the correct answer, and the
			// procedure turns it into a not-found.
			expect(rows).toHaveLength(0);
		});

		it("refuses handing a customer to another purveyor", async () => {
			// USING lets the row be reached; WITH CHECK is what stops it leaving
			// the tenant it was read in.
			await expect(
				rowsFor(
					ids.adminA,
					"update customers set water_purveyor_id = $1 where id = $2 returning id",
					[wpB, customerA],
				),
			).rejects.toThrow(/row-level security/i);
		});

		it("gives nobody a way to delete a customer, Super-Admin included", async () => {
			// No DELETE grant: occupancy history and scheduled jobs point at these
			// rows, so suspension is the reversible switch that exists instead.
			//
			// The Super-Admin case is the one worth asserting rather than reading.
			// `customers_all_super_admin` is written `FOR ALL`, which looks like it
			// covers DELETE — it does, as a policy, and it still gets nowhere,
			// because the grant never handed the privilege over in the first place.
			for (const deleter of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(deleter, "delete from customers where id = $1", [customerA]),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});
});
