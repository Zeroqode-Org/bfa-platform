import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `bfa_assets` and `customer_assignments`
 * policies added in `0004_bfa_asset_policies`.
 *
 * Same shape as `customers-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, which is how a request arrives from PostgREST. The application reads
 * through a privileged connection that bypasses RLS, so nothing in the app
 * would notice these policies break — which is exactly why they need their own
 * suite.
 *
 * Two purveyors are seeded with interchangeable assets — same BIN, same
 * address — so a leak looks like a leak rather than like a plausible row.
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
const assetA = randomUUID();
const assetB = randomUUID();
const customerA = randomUUID();
const customerB = randomUUID();
const assignmentA = randomUUID();
const assignmentB = randomUUID();

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

const insertAsset = `insert into bfa_assets (water_purveyor_id, bin, bfa_type, service_address, annual_test_date)
	 values ($1, $2, 'RP', '2 Policy Way', '2027-04-01') returning id`;

const insertAssignment = `insert into customer_assignments (bfa_asset_id, customer_id, start_date)
	 values ($1, $2, current_date) returning id`;

describeDb("RLS — bfa_assets and customer_assignments", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Asset RLS Water Works', 'ASSET-RLS-A', 'active'),
				        ($2, 'Asset RLS Water Works', 'ASSET-RLS-B', 'active')`,
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
					 values ($1, $2, 'Asset RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			await client.query(
				`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
				 values ($1, $2, 'Shared Name Holdings', 'shared@example.com', 'standard', 'active'),
				        ($3, $4, 'Shared Name Holdings', 'shared@example.com', 'standard', 'active')`,
				[customerA, wpA, customerB, wpB],
			);

			await client.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, current_customer_id, bfa_type, service_address, annual_test_date)
				 values ($1, $2, 'SHARED-RLS-BIN', $3, 'RP', '1 Shared Way', '2027-04-01'),
				        ($4, $5, 'SHARED-RLS-BIN', $6, 'RP', '1 Shared Way', '2027-04-01')`,
				[assetA, wpA, customerA, assetB, wpB, customerB],
			);

			await client.query(
				`insert into customer_assignments (id, bfa_asset_id, customer_id, start_date)
				 values ($1, $2, $3, current_date), ($4, $5, $6, current_date)`,
				[assignmentA, assetA, customerA, assignmentB, assetB, customerB],
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
				`delete from customer_assignments
				 where bfa_asset_id in (select id from bfa_assets where water_purveyor_id = any($1::uuid[]))`,
				[[wpA, wpB]],
			);
			await client.query(
				"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
				[[wpA, wpB]],
			);
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

	describe("bfa_assets reads", () => {
		it("shows every WP role only their own purveyor's assets", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(
					reader,
					"select id from bfa_assets where id = any($1::uuid[])",
					[[assetA, assetB]],
				);

				expect(rows.map((row) => row.id)).toEqual([assetA]);
			}
		});

		it("returns nothing when a WP role names the other tenant's row directly", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from bfa_assets where id = $1",
				[assetB],
			);

			expect(rows).toHaveLength(0);
		});

		it("hides assets from a certifier entirely", async () => {
			// The certifier read path — assets reachable through an active
			// authorization, for wizard prefill — belongs with the wizard. Until it
			// exists, the table is invisible to them.
			const rows = await rowsFor(
				ids.certifier,
				"select id from bfa_assets where id = any($1::uuid[])",
				[[assetA, assetB]],
			);

			expect(rows).toHaveLength(0);
		});

		it("shows both tenants to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from bfa_assets where id = any($1::uuid[])",
				[[assetA, assetB]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual([assetA, assetB].sort());
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(
				ids.blockedAdminA,
				"select id from bfa_assets where id = any($1::uuid[])",
				[[assetA, assetB]],
			);

			expect(rows).toHaveLength(0);
		});
	});

	describe("bfa_assets writes", () => {
		it("lets every WP role register an asset in their own purveyor", async () => {
			for (const writer of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(writer, insertAsset, [
					wpA,
					`POLICY-INSERT-${writer.slice(0, 8)}`,
				]);

				expect(rows).toHaveLength(1);
			}
		});

		it("refuses a WP role writing an asset into the other tenant", async () => {
			await expect(
				rowsFor(ids.employeeA, insertAsset, [wpB, "CROSS-TENANT-INSERT"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a certifier writing an asset at all", async () => {
			await expect(
				rowsFor(ids.certifier, insertAsset, [wpA, "CERTIFIER-INSERT"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("lets a WP role correct their own asset, the BIN included", async () => {
			const rows = await rowsFor(
				ids.employeeA,
				"update bfa_assets set bin = 'CORRECTED-BIN' where id = $1 returning bin",
				[assetA],
			);

			expect(rows).toEqual([{ bin: "CORRECTED-BIN" }]);
		});

		it("refuses a WP role updating the other tenant's asset", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update bfa_assets set bin = 'TAKEN-OVER' where id = $1 returning id",
				[assetB],
			);

			// The row is invisible under USING, so the update matches nothing rather
			// than raising — a silent no-op is the correct answer, and the procedure
			// turns it into a not-found.
			expect(rows).toHaveLength(0);
		});

		it("gives nobody a way to write the status the scheduler owns", async () => {
			// Not a policy question: `asset_status` was never granted to
			// `authenticated`, so no row policy has to argue about it.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						"update bfa_assets set asset_status = 'past_due' where id = $1",
						[assetA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to move an asset to another purveyor", async () => {
			// The UPDATE grant withholds the column, so this fails before any policy
			// is consulted. `bfa_assets_update_own_wp`'s WITH CHECK says the same
			// thing again, for a future migration that widens the grant.
			await expect(
				rowsFor(
					ids.adminA,
					"update bfa_assets set water_purveyor_id = $1 where id = $2",
					[wpB, assetA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("gives nobody a way to delete an asset, Super-Admin included", async () => {
			// Occupancy history, test submissions and scheduled jobs all point at
			// these rows. The Super-Admin policy is written `FOR ALL` and still gets
			// nowhere: the grant never handed DELETE over in the first place.
			for (const deleter of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(deleter, "delete from bfa_assets where id = $1", [assetA]),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});

	describe("customer_assignments", () => {
		it("shows a WP role only the history of assets they can see", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from customer_assignments where id = any($1::uuid[])",
				[[assignmentA, assignmentB]],
			);

			expect(rows.map((row) => row.id)).toEqual([assignmentA]);
		});

		it("hides occupancy history from a certifier", async () => {
			const rows = await rowsFor(
				ids.certifier,
				"select id from customer_assignments where id = any($1::uuid[])",
				[[assignmentA, assignmentB]],
			);

			expect(rows).toHaveLength(0);
		});

		it("lets a WP role open an assignment on their own asset", async () => {
			const rows = await rowsFor(ids.employeeA, insertAssignment, [
				assetA,
				customerA,
			]);

			expect(rows).toHaveLength(1);
		});

		it("refuses an assignment on the other tenant's asset", async () => {
			await expect(
				rowsFor(ids.adminA, insertAssignment, [assetB, customerA]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses an assignment naming the other tenant's customer", async () => {
			// The one cross-tenant row this table could hold: our asset, their
			// customer. `assignCustomer` refuses it too — this is the same refusal
			// for anything arriving another way.
			await expect(
				rowsFor(ids.adminA, insertAssignment, [assetA, customerB]),
			).rejects.toThrow(/row-level security/i);
		});

		it("lets a WP role close their own assignment", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update customer_assignments set end_date = current_date where id = $1 returning id",
				[assignmentA],
			);

			expect(rows).toHaveLength(1);
		});

		it("refuses rewriting which customer a past assignment names", async () => {
			// A past occupancy that can be edited into a different one is not
			// history. Only `end_date` is grantable.
			await expect(
				rowsFor(
					ids.adminA,
					"update customer_assignments set customer_id = $1 where id = $2",
					[customerA, assignmentA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("gives nobody a way to delete an assignment", async () => {
			for (const deleter of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(deleter, "delete from customer_assignments where id = $1", [
						assignmentA,
					]),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});
});
