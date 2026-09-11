import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `test_submissions` policies added in
 * `0008_test_submission_policies` and corrected in
 * `0009_test_submission_asset_tenancy`.
 *
 * Same shape as `bfa-assets-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, which is how a request arrives from PostgREST. The application reads
 * through a privileged connection that bypasses RLS, so nothing in the app
 * would notice these policies break — which is exactly why they need their own
 * suite.
 *
 * Two purveyors are seeded with interchangeable submissions — same BFA type,
 * same typed BIN, same day — so a leak looks like a leak rather than like a
 * plausible row. Each also holds a draft, because the draft rule is not a
 * filter this suite could satisfy by not asking: a WP naming a draft's id
 * directly must still get nothing.
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
	certifierProfileA: randomUUID(),
	blockedAdminA: randomUUID(),
};
const certifierA = randomUUID();
const assetA = randomUUID();
const assetB = randomUUID();
const submittedA = randomUUID();
const submittedB = randomUUID();
const draftA = randomUUID();
const unresolvedA = randomUUID();

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

const correctResult = `update test_submissions set test_result = 'fail' where id = $1 returning id`;

describeDb("RLS — test_submissions", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Submission RLS Water Works', 'SUB-RLS-A', 'active'),
				        ($2, 'Submission RLS Water Works', 'SUB-RLS-B', 'active')`,
				[wpA, wpB],
			);

			const profiles: [string, string | null, string][] = [
				[ids.superAdmin, null, "super_admin"],
				[ids.adminA, wpA, "wp_admin"],
				[ids.subAdminA, wpA, "wp_sub_admin"],
				[ids.employeeA, wpA, "wp_employee"],
				[ids.adminB, wpB, "wp_admin"],
				[ids.certifierProfileA, null, "certifier"],
				[ids.blockedAdminA, wpA, "wp_admin"],
			];

			for (const [id, wp, role] of profiles) {
				await client.query(
					`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
					 values ($1, $2, 'Submission RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			// One certifier files into both purveyors, which is the normal case on
			// this platform and the reason a submission's tenancy cannot be read
			// through the certifier who filed it.
			await client.query(
				`insert into certifiers (id, profile_id, company, status)
				 values ($1, $2, 'Submission RLS Testing', 'active')`,
				[certifierA, ids.certifierProfileA],
			);

			await client.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date)
				 values ($1, $2, 'SHARED-SUB-BIN', 'RP', '1 Shared Way', '2027-04-01'),
				        ($3, $4, 'SHARED-SUB-BIN', 'RP', '1 Shared Way', '2027-04-01')`,
				[assetA, wpA, assetB, wpB],
			);

			const submissions: [string, string | null, string, string, string][] = [
				[submittedA, assetA, wpA, "submitted", "RP"],
				[submittedB, assetB, wpB, "submitted", "RP"],
				[draftA, assetA, wpA, "draft", "RP"],
				// The no-BIN flow: submitted, but attached to no assembly.
				[unresolvedA, null, wpA, "submitted", "DC"],
			];

			for (const [id, assetId, wp, status, bfaType] of submissions) {
				await client.query(
					`insert into test_submissions
					   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
					    wizard_data, submitted_bin_text, test_date, test_result)
					 values ($1, $2, $3, $4, $5::submission_status, $6::bfa_type,
					         '{"fixtureKey":"submission-rls"}'::jsonb, 'SHARED-SUB-BIN', '2027-04-01', 'pass')`,
					[id, assetId, certifierA, wp, status, bfaType],
				);
			}

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
				"delete from test_submissions where water_purveyor_id = any($1::uuid[])",
				[[wpA, wpB]],
			);
			await client.query(
				"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
				[[wpA, wpB]],
			);
			await client.query("delete from certifiers where id = $1", [certifierA]);
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
		it("shows every WP role only their own purveyor's submitted tests", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(
					reader,
					"select id from test_submissions where id = any($1::uuid[]) order by id",
					[[submittedA, submittedB]],
				);

				expect(rows.map((row) => row.id)).toEqual([submittedA]);
			}
		});

		it("returns nothing when a WP role names the other tenant's row directly", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"select id from test_submissions where id = $1",
				[submittedB],
			);

			expect(rows).toHaveLength(0);
		});

		it("hides a draft from every WP role, even inside their own purveyor", async () => {
			// Not a filter the list happens to apply: the draft is invisible, so
			// naming its id gets nothing. A draft is the certifier's working copy of
			// a test nobody has attested to yet.
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(
					reader,
					"select id from test_submissions where id = $1",
					[draftA],
				);

				expect(rows).toHaveLength(0);
			}
		});

		it("shows an unresolved submission, which is the row the screen exists for", async () => {
			// No `bfa_asset_id`, so nothing about this row's tenancy can be read
			// through an asset. The `water_purveyor_id` column is what carries it,
			// which is why the schema denormalises it at submit time.
			const rows = await rowsFor(
				ids.employeeA,
				"select id from test_submissions where id = $1",
				[unresolvedA],
			);

			expect(rows.map((row) => row.id)).toEqual([unresolvedA]);
		});

		it("hides every submission from a certifier, including their own", async () => {
			// The certifier read path — their own drafts and their own submitted
			// archive, § 6.3 — belongs with the wizard that creates those rows.
			// Until it exists the table is invisible to them, which is the
			// failing-closed direction. Every row here was filed by this certifier.
			const rows = await rowsFor(
				ids.certifierProfileA,
				"select id from test_submissions where id = any($1::uuid[])",
				[[submittedA, submittedB, draftA, unresolvedA]],
			);

			expect(rows).toHaveLength(0);
		});

		it("shows both tenants and both states to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from test_submissions where id = any($1::uuid[])",
				[[submittedA, submittedB, draftA]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual(
				[submittedA, submittedB, draftA].sort(),
			);
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(
				ids.blockedAdminA,
				"select id from test_submissions where id = any($1::uuid[])",
				[[submittedA, submittedB]],
			);

			expect(rows).toHaveLength(0);
		});
	});

	describe("writes", () => {
		it("lets a WP Admin and SubAdmin correct their own purveyor's submitted test", async () => {
			for (const writer of [ids.adminA, ids.subAdminA]) {
				const rows = await rowsFor(writer, correctResult, [submittedA]);

				expect(rows).toHaveLength(1);
			}
		});

		it("refuses a WP Employee, who reads submitted tests but does not correct them", async () => {
			// § 6.6.6's own decision, not a project-wide answer to the open
			// SubAdmin/Employee question (PRD § 10). The row is visible under the
			// SELECT policy and reachable by no UPDATE policy, so the statement
			// matches nothing rather than raising.
			const rows = await rowsFor(ids.employeeA, correctResult, [submittedA]);

			expect(rows).toHaveLength(0);
		});

		it("refuses a WP Admin correcting the other tenant's submitted test", async () => {
			const rows = await rowsFor(ids.adminA, correctResult, [submittedB]);

			expect(rows).toHaveLength(0);
		});

		it("refuses every WP role writing a draft", async () => {
			// The certifier's working copy. Invisible under USING, so the update
			// matches nothing.
			for (const writer of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(writer, correctResult, [draftA]);

				expect(rows).toHaveLength(0);
			}
		});

		it("refuses a certifier writing a submitted record at all", async () => {
			// The rule the whole table exists to hold: a certifier's record locks
			// at submit, and their only path to change one is filing a new test.
			const rows = await rowsFor(ids.certifierProfileA, correctResult, [
				submittedA,
			]);

			expect(rows).toHaveLength(0);
		});

		it("lets a WP Admin link an unresolved submission to an asset", async () => {
			const rows = await rowsFor(
				ids.adminA,
				"update test_submissions set bfa_asset_id = $1 where id = $2 returning bfa_asset_id",
				[assetA, unresolvedA],
			);

			expect(rows).toEqual([{ bfa_asset_id: assetA }]);
		});

		it("refuses linking a submission to the other tenant's asset", async () => {
			// The regression `0009_test_submission_asset_tenancy` exists for.
			//
			// Every clause 0008's policy checked is satisfied here: the caller is a
			// WP Admin, the submission is theirs, and it is submitted. Only the
			// *asset* belongs to somebody else, and `bfa_asset_id` is necessarily in
			// the UPDATE grant because linking is what this screen does to it. So
			// nothing refused this until the WITH CHECK learned to look at what the
			// column points at.
			//
			// Not a quiet cross-tenant row either: `listSubmittedTests` and
			// `getSubmittedTest` both LEFT JOIN `bfa_assets` through this column on
			// the privileged connection, so a foreign asset's BIN and service
			// address would come back on a row the caller is entitled to read.
			await expect(
				rowsFor(
					ids.adminA,
					"update test_submissions set bfa_asset_id = $1 where id = $2",
					[assetB, unresolvedA],
				),
			).rejects.toThrow(/row-level security/i);
		});

		it("leaves the submission unresolved after that refusal", async () => {
			// Read back outside the refused statement's own transaction: the failure
			// aborts that one, so proving the row survived has to happen in another.
			const rows = await rowsFor(
				ids.superAdmin,
				"select bfa_asset_id from test_submissions where id = $1",
				[unresolvedA],
			);

			expect(rows).toEqual([{ bfa_asset_id: null }]);
		});

		it("refuses re-pointing a resolved submission at the other tenant's asset", async () => {
			// The same hole from the other direction: not linking an unresolved row
			// but moving a row that already has an asset onto a foreign one.
			await expect(
				rowsFor(
					ids.adminA,
					"update test_submissions set bfa_asset_id = $1 where id = $2",
					[assetB, submittedA],
				),
			).rejects.toThrow(/row-level security/i);
		});

		it("keeps an unresolved submission correctable while it stays unresolved", async () => {
			// `bfa_asset_id IS NULL` has to remain valid under the new clause. The
			// no-BIN flow (PRD § 7, flow 2) is the normal way these arrive, and most
			// of what this screen exists to work through is corrections made to a
			// row before anybody has worked out which assembly it belongs to.
			const rows = await rowsFor(
				ids.adminA,
				"update test_submissions set test_result = 'fail' where id = $1 returning bfa_asset_id",
				[unresolvedA],
			);

			expect(rows).toEqual([{ bfa_asset_id: null }]);
		});

		it("lets a WP Admin clear a link that was made in error", async () => {
			// Setting the column back to NULL stays allowed too — a submission
			// resolved to the wrong assembly has to be un-resolvable, or the repair
			// path for a mis-link would be no path at all.
			const rows = await rowsFor(
				ids.adminA,
				"update test_submissions set bfa_asset_id = null where id = $1 returning bfa_asset_id",
				[submittedA],
			);

			expect(rows).toEqual([{ bfa_asset_id: null }]);
		});

		it("gives nobody a way to reopen a submitted test as a draft", async () => {
			// Not a policy question: `status` was never granted to `authenticated`,
			// so no row policy has to argue about it. Reopening one would hand a
			// locked record back to the certifier.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						"update test_submissions set status = 'draft' where id = $1",
						[submittedA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to move a submission to another purveyor", async () => {
			// The UPDATE grant withholds the column, so this fails before any policy
			// is consulted. The WITH CHECK says the same thing again, for a future
			// migration that widens the grant.
			await expect(
				rowsFor(
					ids.adminA,
					"update test_submissions set water_purveyor_id = $1 where id = $2",
					[wpB, submittedA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("gives nobody a way to move a test onto a different certifier", async () => {
			await expect(
				rowsFor(
					ids.adminA,
					"update test_submissions set certifier_id = $1 where id = $2",
					[certifierA, submittedA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("gives nobody a way to clear the certifier's overridden-field flags", async () => {
			// The marker exists so the WP can see what the certifier typed over. A
			// WP able to rewrite it could clear the flags rather than answer them.
			await expect(
				rowsFor(
					ids.adminA,
					"update test_submissions set overridden_fields = '[]'::jsonb where id = $1",
					[submittedA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("gives nobody a way to attribute an edit to somebody else", async () => {
			// Withheld from the grant, so a caller cannot choose the value. The
			// trigger writes it instead — see the next test.
			await expect(
				rowsFor(
					ids.adminA,
					"update test_submissions set edited_by_wp_profile_id = $1 where id = $2",
					[ids.employeeA, submittedA],
				),
			).rejects.toThrow(/permission denied/i);
		});

		it("stamps the caller onto every correction that changes something", async () => {
			const rows = await rowsFor(
				ids.subAdminA,
				correctResult.replace(
					"returning id",
					"returning edited_by_wp_profile_id",
				),
				[submittedA],
			);

			expect(rows).toEqual([{ edited_by_wp_profile_id: ids.subAdminA }]);
		});

		it("writes nothing at all when the statement changes nothing", async () => {
			// A `set` that writes the value already present is not a correction, so
			// it must leave no trace in either bookkeeping column: not
			// `edited_by_wp_profile_id`, which would then name the last person to
			// have *touched* the row rather than the last to have changed it, and
			// not `updated_at`, which would come to mean "when somebody last pressed
			// save". `set_updated_at` from 0000 assigns that column unconditionally,
			// so declining to attribute is not enough on its own — the trigger has
			// to skip the row, which it does by returning NULL.
			//
			// One transaction, so the before and after reads bracket the statement
			// without the rollback in between.
			await asUser(ids.adminA, async (client) => {
				const before = await client.query(
					"select updated_at, edited_by_wp_profile_id from test_submissions where id = $1",
					[submittedA],
				);

				const noop = await client.query(
					"update test_submissions set test_result = test_result where id = $1 returning id",
					[submittedA],
				);

				const after = await client.query(
					"select updated_at, edited_by_wp_profile_id from test_submissions where id = $1",
					[submittedA],
				);

				// Suppressed: no row version written, so nothing to return.
				expect(noop.rowCount).toBe(0);
				expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
				expect(after.rows[0]?.edited_by_wp_profile_id).toBeNull();
			});
		});

		it("still writes and stamps when the same statement changes something", async () => {
			// The other half, so the suppression above cannot quietly grow into
			// "this table ignores updates". A real correction moves both columns.
			await asUser(ids.subAdminA, async (client) => {
				const before = await client.query(
					"select updated_at from test_submissions where id = $1",
					[submittedA],
				);

				const real = await client.query(
					"update test_submissions set test_result = 'fail' where id = $1 returning id",
					[submittedA],
				);

				const after = await client.query(
					"select updated_at, edited_by_wp_profile_id from test_submissions where id = $1",
					[submittedA],
				);

				expect(real.rowCount).toBe(1);
				expect(after.rows[0]?.edited_by_wp_profile_id).toBe(ids.subAdminA);
				expect(after.rows[0]?.updated_at > before.rows[0]?.updated_at).toBe(
					true,
				);
			});
		});

		it("gives nobody a way to insert a submission, Super-Admin included", async () => {
			// A submission is created by the certifier wizard through the privileged
			// connection. A row inserted through PostgREST would be a test nobody
			// performed. The Super-Admin policy reads `FOR ALL` and still gets
			// nowhere: a policy cannot hand back a privilege the grant never gave.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						`insert into test_submissions (bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type, wizard_data)
						 values ($1, $2, $3, 'submitted', 'RP', '{}'::jsonb)`,
						[assetA, certifierA, wpA],
					),
				).rejects.toThrow(/permission denied/i);
			}
		});

		it("gives nobody a way to delete a submission, Super-Admin included", async () => {
			// A submitted test is evidence of a backflow test. Nothing in the
			// product removes one.
			for (const deleter of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(deleter, "delete from test_submissions where id = $1", [
						submittedA,
					]),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});
});
