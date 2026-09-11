import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `notice_templates` policies added in
 * `0010_notice_template_policies`.
 *
 * Same shape as `repair-companies-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, which is how a request arrives from PostgREST. The application reads
 * through a privileged connection that bypasses RLS, so nothing in the app
 * would notice these policies break — which is exactly why they need their own
 * suite.
 *
 * Two purveyors are seeded with interchangeable templates, so a leak looks like
 * a leak rather than like a plausible row.
 *
 * The read/write split here is narrower than `repair_companies`: all three WP
 * roles read, and only `wp_admin` writes. Rewriting a notice template changes
 * what every customer of the purveyor is sent in the purveyor's name.
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
const templateA = randomUUID();
const templateB = randomUUID();

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

const insertTemplate = `insert into notice_templates (water_purveyor_id, notice_type, subject, body)
	 values ($1, $2::notice_type, 'Policy subject', 'Policy body') returning id`;

describeDb("RLS — notice_templates", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Notice RLS Water Works', 'NOTICE-RLS-A', 'active'),
				        ($2, 'Notice RLS Water Works', 'NOTICE-RLS-B', 'active')`,
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
					 values ($1, $2, 'Notice RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			// Same notice type, same text, two tenants: if one shows up in the
			// other's list it is unmistakably the wrong row.
			await client.query(
				`insert into notice_templates (id, water_purveyor_id, notice_type, subject, body)
				 values ($1, $2, 'reminder', 'Shared reminder subject', 'Shared reminder body'),
				        ($3, $4, 'reminder', 'Shared reminder subject', 'Shared reminder body')`,
				[templateA, wpA, templateB, wpB],
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
				"delete from notice_templates where water_purveyor_id = any($1::uuid[])",
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
		it("shows every WP role only their own purveyor's templates", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(reader, "select id from notice_templates");

				expect(rows.map((row) => row.id)).toEqual([templateA]);
			}
		});

		it("returns nothing when a WP role names the other tenant's row directly", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from notice_templates where id = $1",
				[templateB],
			);

			expect(rows).toHaveLength(0);
		});

		it("hides notice templates from a certifier entirely", async () => {
			// A certifier tests assemblies. What the purveyor writes to its own
			// customers is not theirs to read.
			const rows = await rowsFor(
				ids.certifier,
				"select id from notice_templates",
			);

			expect(rows).toHaveLength(0);
		});

		it("shows both tenants to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from notice_templates where id = any($1::uuid[])",
				[[templateA, templateB]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual(
				[templateA, templateB].sort(),
			);
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(
				ids.blockedAdminA,
				"select id from notice_templates",
			);

			expect(rows).toHaveLength(0);
		});
	});

	describe("writes", () => {
		it("lets a WP Admin add a template to their own purveyor", async () => {
			const rows = await rowsFor(ids.adminA, insertTemplate, [
				wpA,
				"late_notice_1",
			]);

			expect(rows).toHaveLength(1);
		});

		it("refuses a SubAdmin and an Employee the insert", async () => {
			// They read the screen; they do not change what customers are sent.
			for (const writer of [ids.subAdminA, ids.employeeA]) {
				await expect(
					rowsFor(writer, insertTemplate, [wpA, "late_notice_2"]),
				).rejects.toThrow(/row-level security/i);
			}
		});

		it("refuses a SubAdmin and an Employee the update", async () => {
			for (const writer of [ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(
					writer,
					"update notice_templates set subject = 'Edited by a reader' where id = $1 returning id",
					[templateA],
				);

				// Visible under SELECT, unreachable under UPDATE: the row policy's
				// USING clause matches nothing, so the statement is a no-op rather
				// than an error.
				expect(rows).toHaveLength(0);
			}
		});

		it("lets a Super-Admin add a template to any tenant", async () => {
			const rows = await rowsFor(ids.superAdmin, insertTemplate, [
				wpB,
				"final_notice",
			]);

			expect(rows).toHaveLength(1);
		});

		it("refuses a WP Admin writing a template into the other tenant", async () => {
			await expect(
				rowsFor(ids.adminA, insertTemplate, [wpB, "late_notice_1"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a certifier writing a template at all", async () => {
			await expect(
				rowsFor(ids.certifier, insertTemplate, [wpA, "late_notice_1"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("refuses a blocked profile writing a template", async () => {
			await expect(
				rowsFor(ids.blockedAdminA, insertTemplate, [wpA, "late_notice_1"]),
			).rejects.toThrow(/row-level security/i);
		});

		it("lets a WP Admin rewrite their own template", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update notice_templates set subject = 'Rewritten', body = 'Rewritten body' where id = $1 returning subject",
				[templateA],
			);

			expect(rows).toEqual([{ subject: "Rewritten" }]);
		});

		it("refuses a WP Admin updating the other tenant's template", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update notice_templates set subject = 'Taken over' where id = $1 returning id",
				[templateB],
			);

			// The row is invisible under USING, so the update matches nothing rather
			// than raising — a silent no-op is the correct answer.
			expect(rows).toHaveLength(0);
		});

		it("gives nobody a way to move a template to another purveyor", async () => {
			// `water_purveyor_id` is not in the UPDATE grant, so this is refused a
			// column at a time before any policy is consulted. The `WITH CHECK` on
			// `notice_templates_update_own_wp` says the same thing a second time,
			// for the day a later migration widens the grant.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						"update notice_templates set water_purveyor_id = $1 where id = $2",
						[wpB, templateA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to re-type an existing template", async () => {
			// The pair (`water_purveyor_id`, `notice_type`) is the template's
			// identity. Re-typing a row is not an edit to it; it is a different
			// template, which the INSERT path already creates.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						"update notice_templates set notice_type = 'final_notice' where id = $1",
						[templateA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to flip is_enabled", async () => {
			// The column exists and stays unwired: automated notices are switched on
			// per purveyor by the Super-Admin through `wp_feature_flags`. Withholding
			// the privilege is what keeps "we did not build the toggle" from being
			// only a UI decision.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						"update notice_templates set is_enabled = false where id = $1",
						[templateA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to delete a notice template, Super-Admin included", async () => {
			// No DELETE grant. A deleted row is indistinguishable from one that was
			// never written — and the row's absence is what means "this purveyor
			// uses the platform default" — so there is nothing deleting would
			// express that rewriting the text does not.
			for (const deleter of [
				ids.adminA,
				ids.subAdminA,
				ids.employeeA,
				ids.superAdmin,
			]) {
				await expect(
					rowsFor(deleter, "delete from notice_templates where id = $1", [
						templateA,
					]),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("keeps one template per type per purveyor", async () => {
			// The unique constraint from 0000 is what makes `upsertNoticeTemplate` an
			// upsert rather than a race two saves could lose.
			await expect(
				rowsFor(ids.adminA, insertTemplate, [wpA, "reminder"]),
			).rejects.toThrow(/duplicate key|unique constraint/i);
		});

		it("still lets the same type exist once in each tenant", async () => {
			const { rows } = await pool.query(
				"select water_purveyor_id from notice_templates where notice_type = 'reminder' and id = any($1::uuid[])",
				[[templateA, templateB]],
			);

			expect(rows).toHaveLength(2);
		});
	});
});
