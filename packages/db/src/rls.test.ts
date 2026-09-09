import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `invitations` and `profiles` policies.
 *
 * These run as the `authenticated` Postgres role with `request.jwt.claims` set
 * to a fixture profile, which is exactly how a request arrives from PostgREST —
 * so what passes here is what a signed-in user can actually do. The application
 * itself reads through a privileged connection that bypasses RLS, which is why
 * the policies need their own test: nothing in the app would notice them break.
 *
 * Two purveyors are seeded with deliberately interchangeable data. A leak
 * between them has to look like a leak, not like a plausible row.
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
	employeeB: randomUUID(),
	certifier: randomUUID(),
	blockedAdminA: randomUUID(),
};
const invitationA = randomUUID();
const invitationB = randomUUID();

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

function futureTimestamp() {
	return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

describeDb("RLS — invitations and profiles", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'RLS Fixture Water Works', 'RLS-FIXTURE-A', 'active'),
				        ($2, 'RLS Fixture Water Works', 'RLS-FIXTURE-B', 'active')`,
				[wpA, wpB],
			);

			const profiles: [string, string | null, string, string][] = [
				[ids.superAdmin, null, "Fixture Super Admin", "super_admin"],
				[ids.adminA, wpA, "Fixture Admin", "wp_admin"],
				[ids.subAdminA, wpA, "Fixture Sub Admin", "wp_sub_admin"],
				[ids.employeeA, wpA, "Fixture Employee", "wp_employee"],
				[ids.adminB, wpB, "Fixture Admin", "wp_admin"],
				[ids.employeeB, wpB, "Fixture Employee", "wp_employee"],
				[ids.certifier, null, "Fixture Certifier", "certifier"],
				[ids.blockedAdminA, wpA, "Fixture Blocked Admin", "wp_admin"],
			];

			for (const [id, wp, fullName, role] of profiles) {
				await client.query(
					`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
					 values ($1, $2, $3, $4::global_role, $5::active_blocked)`,
					[
						id,
						wp,
						fullName,
						role,
						id === ids.blockedAdminA ? "blocked" : "active",
					],
				);
			}

			await client.query(
				`insert into invitations (id, email, role, token, status, expires_at, associated_wp_id, invited_by_profile_id, is_redeemed)
				 values ($1, 'shared.name@example.com', 'certifier', $2, 'pending', $3, $4, $5, false),
				        ($6, 'shared.name@example.com', 'certifier', $7, 'pending', $3, $8, $9, false)`,
				[
					invitationA,
					`rls-fixture-${invitationA}`,
					futureTimestamp(),
					wpA,
					ids.adminA,
					invitationB,
					`rls-fixture-${invitationB}`,
					wpB,
					ids.adminB,
				],
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
				"delete from invitations where associated_wp_id = any($1::uuid[])",
				[[wpA, wpB]],
			);
			await client.query(
				"delete from wp_certifier_authorizations where water_purveyor_id = any($1::uuid[])",
				[[wpA, wpB]],
			);
			await client.query(
				"delete from certifiers where profile_id = any($1::uuid[])",
				[Object.values(ids)],
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

	describe("invitations — reads", () => {
		it("shows a WP role only their own purveyor's invitations", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(
					reader,
					"select id, associated_wp_id from invitations",
				);

				expect(rows.map((row) => row.id)).toEqual([invitationA]);
			}
		});

		it("returns nothing when a WP role names the other tenant's row directly", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from invitations where id = $1",
				[invitationB],
			);

			expect(rows).toHaveLength(0);
		});

		it("hides invitations from a certifier entirely", async () => {
			const rows = await rowsFor(ids.certifier, "select id from invitations");

			expect(rows).toHaveLength(0);
		});

		it("shows both tenants to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from invitations where id = any($1::uuid[])",
				[[invitationA, invitationB]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual(
				[invitationA, invitationB].sort(),
			);
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(
				ids.blockedAdminA,
				"select id from invitations",
			);

			expect(rows).toHaveLength(0);
		});
	});

	describe("invitations — writes", () => {
		const insert = `insert into invitations (email, role, token, status, expires_at, associated_wp_id, invited_by_profile_id, is_redeemed)
			 values ($1, 'certifier', $2, 'pending', $3, $4, $5, false) returning id`;

		it("lets every WP role invite into their own purveyor", async () => {
			for (const writer of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(writer, insert, [
					"new.invitee@example.com",
					`rls-write-${randomUUID()}`,
					futureTimestamp(),
					wpA,
					writer,
				]);

				expect(rows).toHaveLength(1);
			}
		});

		it("refuses a WP role writing an invitation for the other tenant", async () => {
			await expect(
				rowsFor(ids.employeeA, insert, [
					"cross.tenant@example.com",
					`rls-write-${randomUUID()}`,
					futureTimestamp(),
					wpB,
					ids.employeeA,
				]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a WP role provisioning a new purveyor with a null WP", async () => {
			await expect(
				rowsFor(ids.adminA, insert, [
					"new.purveyor@example.com",
					`rls-write-${randomUUID()}`,
					futureTimestamp(),
					null,
					ids.adminA,
				]),
			).rejects.toThrow(/row-level security/i);
		});

		it("lets a Super-Admin provision a new purveyor with a null WP", async () => {
			const rows = await rowsFor(ids.superAdmin, insert, [
				"new.purveyor@example.com",
				`rls-write-${randomUUID()}`,
				futureTimestamp(),
				null,
				ids.superAdmin,
			]);

			expect(rows).toHaveLength(1);
		});

		it("refuses a certifier writing an invitation at all", async () => {
			await expect(
				rowsFor(ids.certifier, insert, [
					"certifier.tried@example.com",
					`rls-write-${randomUUID()}`,
					futureTimestamp(),
					wpA,
					ids.certifier,
				]),
			).rejects.toThrow(/row-level security/i);
		});

		it("gives a WP role no way to edit or delete an invitation", async () => {
			const updated = await rowsFor(
				ids.adminA,
				"update invitations set is_redeemed = true where id = $1 returning id",
				[invitationA],
			);
			const deleted = await rowsFor(
				ids.adminA,
				"delete from invitations where id = $1 returning id",
				[invitationA],
			);

			expect(updated).toHaveLength(0);
			expect(deleted).toHaveLength(0);
		});
	});

	describe("profiles", () => {
		it("lets anyone read their own row", async () => {
			const rows = await rowsFor(
				ids.employeeB,
				"select id from profiles where id = $1",
				[ids.employeeB],
			);

			expect(rows.map((row) => row.id)).toEqual([ids.employeeB]);
		});

		it("lets a WP Admin and SubAdmin read their own purveyor's profiles", async () => {
			for (const reader of [ids.adminA, ids.subAdminA]) {
				const rows = await rowsFor(
					reader,
					"select id from profiles where water_purveyor_id = $1",
					[wpA],
				);

				expect(rows.map((row) => row.id).sort()).toEqual(
					[ids.adminA, ids.subAdminA, ids.employeeA, ids.blockedAdminA].sort(),
				);
			}
		});

		it("shows a WP Admin nothing from the other purveyor", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from profiles where water_purveyor_id = $1",
				[wpB],
			);

			expect(rows).toHaveLength(0);
		});

		it("gives a WP Employee no view beyond their own row", async () => {
			const rows = await rowsFor(
				ids.employeeA,
				"select id from profiles where water_purveyor_id = $1",
				[wpA],
			);

			expect(rows.map((row) => row.id)).toEqual([ids.employeeA]);
		});

		it("gives a certifier no view beyond their own row", async () => {
			const rows = await rowsFor(ids.certifier, "select id from profiles");

			expect(rows.map((row) => row.id)).toEqual([ids.certifier]);
		});

		it("lets a user rename themselves", async () => {
			const rows = await rowsFor(
				ids.employeeA,
				"update profiles set full_name = $2 where id = $1 returning full_name",
				[ids.employeeA, "Renamed By Owner"],
			);

			expect(rows).toEqual([{ full_name: "Renamed By Owner" }]);
		});

		it("refuses a self-service role or tenant change, by column grant", async () => {
			await expect(
				rowsFor(
					ids.employeeA,
					"update profiles set global_role = 'super_admin' where id = $1 returning id",
					[ids.employeeA],
				),
			).rejects.toThrow(/permission denied/i);

			await expect(
				rowsFor(
					ids.employeeA,
					"update profiles set water_purveyor_id = $2 where id = $1 returning id",
					[ids.employeeA, wpB],
				),
			).rejects.toThrow(/permission denied/i);

			await expect(
				rowsFor(
					ids.blockedAdminA,
					"update profiles set status = 'active' where id = $1 returning id",
					[ids.blockedAdminA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("refuses a WP Admin renaming someone in the other purveyor", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update profiles set full_name = 'Hijacked' where id = $1 returning id",
				[ids.employeeB],
			);

			expect(rows).toHaveLength(0);
		});

		it("refuses every authenticated insert — profiles come from redemption only", async () => {
			await expect(
				rowsFor(
					ids.superAdmin,
					`insert into profiles (id, water_purveyor_id, full_name, global_role)
					 values ($1, $2, 'Smuggled In', 'wp_admin') returning id`,
					[randomUUID(), wpA],
				),
			).rejects.toThrow(/permission denied|row-level security/i);
		});
	});
});
