import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * RLS tests for `wp_certifier_authorizations`, added in
 * `0013_certifier_wp_authorization_policies` (§ 6.4, the Certifier WP
 * selector).
 *
 * Same shape as `certifiers-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, matching how a request arrives from PostgREST. The application
 * itself reads through the privileged Drizzle connection and never touches
 * this policy, so nothing in the app would notice it break.
 *
 * Only a SELECT policy exists — a certifier reads their own authorization
 * rows, of any status, and nobody else (no WP role, no Super-Admin) has any
 * grant on the table yet. `authorization_status` is not filtered here: the
 * policy is row-ownership only, the same way `certifier.listAuthorizedWps`
 * filters to `active` in the procedure rather than the policy.
 *
 * Opt-in: this suite writes to a real database, so it runs only under
 * `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wpA = randomUUID();
const wpB = randomUUID();
const ids = {
	certifierAProfile: randomUUID(),
	certifierBProfile: randomUUID(),
};
const certifierA = randomUUID();
const certifierB = randomUUID();

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

describeDb("RLS — wp_certifier_authorizations", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'WP Authorization RLS Water Works A', 'AUTH-RLS-A', 'active'),
				        ($2, 'WP Authorization RLS Water Works B', 'AUTH-RLS-B', 'active')`,
				[wpA, wpB],
			);

			await client.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, null, 'WP Authorization RLS Fixture', 'certifier'::global_role, 'active'),
				        ($2, null, 'WP Authorization RLS Fixture', 'certifier'::global_role, 'active')`,
				[ids.certifierAProfile, ids.certifierBProfile],
			);

			await client.query(
				`insert into certifiers (id, profile_id, company, id_number, license_expiration_date, status)
				 values ($1, $2, 'Fixture A', 'AUTH-RLS-1', '2029-01-01', 'active'),
				        ($3, $4, 'Fixture B', 'AUTH-RLS-2', '2029-01-01', 'active')`,
				[certifierA, ids.certifierAProfile, certifierB, ids.certifierBProfile],
			);

			// Certifier A: one `active` row and one `pending`/`revoked` row (any
			// status is visible under the policy — only ownership is checked).
			// Certifier B: one `active` row of their own.
			await client.query(
				`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
				 values ($1, $2, 'active'),
				        ($1, $3, 'revoked'),
				        ($4, $3, 'active')`,
				[certifierA, wpA, wpB, certifierB],
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
				"delete from wp_certifier_authorizations where certifier_id = any($1::uuid[])",
				[[certifierA, certifierB]],
			);
			await client.query("delete from certifiers where id = any($1::uuid[])", [
				[certifierA, certifierB],
			]);
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

	it("shows a certifier every one of their own rows, any status", async () => {
		const rows = await rowsFor(
			ids.certifierAProfile,
			"select water_purveyor_id, authorization_status from wp_certifier_authorizations where certifier_id = $1 order by water_purveyor_id",
			[certifierA],
		);

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.authorization_status).sort()).toEqual(
			["active", "revoked"].sort(),
		);
	});

	it("gives a certifier nothing from another certifier's rows", async () => {
		const rows = await rowsFor(
			ids.certifierAProfile,
			"select 1 from wp_certifier_authorizations where certifier_id = $1",
			[certifierB],
		);

		expect(rows).toHaveLength(0);
	});

	it("returns nothing when a certifier scans the whole table", async () => {
		// No filter at all still only returns the caller's own rows — proves the
		// policy, not the query, is doing the narrowing.
		const rows = await rowsFor(
			ids.certifierAProfile,
			"select certifier_id from wp_certifier_authorizations",
		);

		expect(rows.every((row) => row.certifier_id === certifierA)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
	});

	it("gives nobody a way to insert, update, or delete a row", async () => {
		await expect(
			rowsFor(
				ids.certifierAProfile,
				`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
				 values ($1, $2, 'active')`,
				[certifierA, wpB],
			),
		).rejects.toThrow(/permission denied/i);

		await expect(
			rowsFor(
				ids.certifierAProfile,
				"update wp_certifier_authorizations set authorization_status = 'active' where certifier_id = $1 and water_purveyor_id = $2",
				[certifierA, wpB],
			),
		).rejects.toThrow(/permission denied/i);

		await expect(
			rowsFor(
				ids.certifierAProfile,
				"delete from wp_certifier_authorizations where certifier_id = $1 and water_purveyor_id = $2",
				[certifierA, wpA],
			),
		).rejects.toThrow(/permission denied/i);
	});
});
