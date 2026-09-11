import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `repair_companies` policies added in
 * `0005_repair_company_policies`.
 *
 * Same shape as `customers-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, which is how a request arrives from PostgREST. The application reads
 * through a privileged connection that bypasses RLS, so nothing in the app
 * would notice these policies break — which is exactly why they need their own
 * suite.
 *
 * Two purveyors are seeded with interchangeable companies, so a leak looks like
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
const companyA = randomUUID();
const companyB = randomUUID();

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

const insertCompany = `insert into repair_companies (water_purveyor_id, company_name, phone, email, status)
	 values ($1, $2, '555-0177', 'policy.write@example.com', 'active') returning id`;

describeDb("RLS — repair_companies", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Repair RLS Water Works', 'REPAIR-RLS-A', 'active'),
				        ($2, 'Repair RLS Water Works', 'REPAIR-RLS-B', 'active')`,
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
					 values ($1, $2, 'Repair RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			await client.query(
				`insert into repair_companies (id, water_purveyor_id, company_name, phone, email, status)
				 values ($1, $2, 'Shared Name Backflow', '555-0100', 'shared@example.com', 'active'),
				        ($3, $4, 'Shared Name Backflow', '555-0100', 'shared@example.com', 'active')`,
				[companyA, wpA, companyB, wpB],
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
				"delete from repair_companies where water_purveyor_id = any($1::uuid[])",
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
		it("shows every WP role only their own purveyor's companies", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(reader, "select id from repair_companies");

				expect(rows.map((row) => row.id)).toEqual([companyA]);
			}
		});

		it("returns nothing when a WP role names the other tenant's row directly", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from repair_companies where id = $1",
				[companyB],
			);

			expect(rows).toHaveLength(0);
		});

		it("hides repair companies from a certifier entirely", async () => {
			// A certifier records that an assembly failed. Who the purveyor
			// recommends for the repair reaches the customer through the failure
			// notice, not through the wizard, so the table is invisible to them.
			const rows = await rowsFor(
				ids.certifier,
				"select id from repair_companies",
			);

			expect(rows).toHaveLength(0);
		});

		it("shows both tenants to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from repair_companies where id = any($1::uuid[])",
				[[companyA, companyB]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual(
				[companyA, companyB].sort(),
			);
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(
				ids.blockedAdminA,
				"select id from repair_companies",
			);

			expect(rows).toHaveLength(0);
		});
	});

	describe("writes", () => {
		it("lets every WP role add a company to their own purveyor", async () => {
			for (const writer of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(writer, insertCompany, [
					wpA,
					"Policy Insert",
				]);

				expect(rows).toHaveLength(1);
			}
		});

		it("lets a Super-Admin add a company to any tenant", async () => {
			const rows = await rowsFor(ids.superAdmin, insertCompany, [
				wpB,
				"Super Admin Insert",
			]);

			expect(rows).toHaveLength(1);
		});

		it("refuses a WP role writing a company into the other tenant", async () => {
			await expect(
				rowsFor(ids.employeeA, insertCompany, [wpB, "Cross Tenant Insert"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a certifier writing a company at all", async () => {
			await expect(
				rowsFor(ids.certifier, insertCompany, [wpA, "Certifier Insert"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a blocked profile writing a company", async () => {
			await expect(
				rowsFor(ids.blockedAdminA, insertCompany, [wpA, "Blocked Insert"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("lets a WP role deactivate their own company", async () => {
			const rows = await rowsFor(
				ids.employeeA,
				"update repair_companies set status = 'inactive' where id = $1 returning status",
				[companyA],
			);

			expect(rows).toEqual([{ status: "inactive" }]);
		});

		it("refuses a WP role updating the other tenant's company", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update repair_companies set status = 'inactive' where id = $1 returning id",
				[companyB],
			);

			// The row is invisible under USING, so the update matches nothing rather
			// than raising — a silent no-op is the correct answer, and the procedure
			// turns it into a not-found.
			expect(rows).toHaveLength(0);
		});

		it("gives nobody a way to move a company to another purveyor", async () => {
			// `water_purveyor_id` is not in the UPDATE grant, so this is refused a
			// column at a time before any policy is consulted. The `WITH CHECK` on
			// `repair_companies_update_own_wp` says the same thing a second time,
			// for the day a later migration widens the grant.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						"update repair_companies set water_purveyor_id = $1 where id = $2",
						[wpB, companyA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to delete a repair company, Super-Admin included", async () => {
			// No DELETE grant. The failure notice names the companies that were
			// active when it was sent; deleting a row would edit what a past notice
			// said. `status = 'inactive'` is the reversible switch that exists
			// instead.
			//
			// The Super-Admin case is the one worth asserting rather than reading.
			// `repair_companies_all_super_admin` is written `FOR ALL`, which looks
			// like it covers DELETE — it does, as a policy, and it still gets
			// nowhere, because the grant never handed the privilege over.
			for (const deleter of [
				ids.adminA,
				ids.subAdminA,
				ids.employeeA,
				ids.superAdmin,
			]) {
				await expect(
					rowsFor(deleter, "delete from repair_companies where id = $1", [
						companyA,
					]),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});
});
