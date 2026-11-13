import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Multi-tenant isolation tests for the `certifiers` policies added in
 * `0006_certifier_policies`.
 *
 * Same shape as `repair-companies-rls.test.ts`: every statement runs as the
 * `authenticated` Postgres role with `request.jwt.claims` set to a fixture
 * profile, which is how a request arrives from PostgREST. The application reads
 * through a privileged connection that bypasses RLS, so nothing in the app
 * would notice these policies break — which is exactly why they need their own
 * suite.
 *
 * `certifiers` is the first table here whose WP policy is a join rather than a
 * `water_purveyor_id` comparison: a certifier is not a tenant of a purveyor,
 * and the relationship lives in `wp_certifier_authorizations`. Two purveyors
 * are seeded with interchangeable certifiers plus one authorized for both, so a
 * leak looks like a leak and a shared certifier looks like sharing.
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
	blockedAdminA: randomUUID(),
	certifierAProfile: randomUUID(),
	certifierBProfile: randomUUID(),
	certifierSharedProfile: randomUUID(),
	certifierBlockedProfile: randomUUID(),
};
const certifierA = randomUUID();
const certifierB = randomUUID();
const certifierShared = randomUUID();
/** Starts blocked and stays blocked — the self-service paths a block closes. */
const certifierBlocked = randomUUID();

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

describeDb("RLS — certifiers", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				`insert into water_purveyors (id, company_name, pwsid, status)
				 values ($1, 'Certifier RLS Water Works', 'CERT-RLS-A', 'active'),
				        ($2, 'Certifier RLS Water Works', 'CERT-RLS-B', 'active')`,
				[wpA, wpB],
			);

			const profileRows: [string, string | null, string][] = [
				[ids.superAdmin, null, "super_admin"],
				[ids.adminA, wpA, "wp_admin"],
				[ids.subAdminA, wpA, "wp_sub_admin"],
				[ids.employeeA, wpA, "wp_employee"],
				[ids.adminB, wpB, "wp_admin"],
				[ids.blockedAdminA, wpA, "wp_admin"],
				[ids.certifierAProfile, null, "certifier"],
				[ids.certifierBProfile, null, "certifier"],
				[ids.certifierSharedProfile, null, "certifier"],
				[ids.certifierBlockedProfile, null, "certifier"],
			];

			for (const [id, wp, role] of profileRows) {
				await client.query(
					`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
					 values ($1, $2, 'Certifier RLS Fixture', $3::global_role, $4::active_blocked)`,
					[id, wp, role, id === ids.blockedAdminA ? "blocked" : "active"],
				);
			}

			await client.query(
				`insert into certifiers (id, profile_id, company, id_number, license_expiration_date, status)
				 values ($1, $2, 'Shared Name Testing', 'LIC-RLS-1', '2027-01-31', 'active'),
				        ($3, $4, 'Shared Name Testing', 'LIC-RLS-1', '2027-01-31', 'active'),
				        ($5, $6, 'Two Purveyor Testing', 'LIC-RLS-2', '2027-06-30', 'active'),
				        ($7, $8, 'Blocked Testing', 'LIC-RLS-3', '2027-09-30', 'blocked')`,
				[
					certifierA,
					ids.certifierAProfile,
					certifierB,
					ids.certifierBProfile,
					certifierShared,
					ids.certifierSharedProfile,
					certifierBlocked,
					ids.certifierBlockedProfile,
				],
			);

			await client.query(
				`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
				 values ($1, $2, 'active'), ($3, $4, 'active'), ($5, $2, 'active'), ($5, $4, 'active'), ($6, $2, 'active')`,
				[certifierA, wpA, certifierB, wpB, certifierShared, certifierBlocked],
			);

			await client.query("commit");
		} catch (error) {
			await client.query("rollback").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	});

	beforeEach(async () => {
		// Every statement below runs in a rolled-back transaction, so this is belt
		// and braces — but a fixture that silently drifted would make the read
		// assertions meaningless rather than failing.
		await pool.query(
			"update certifiers set status = 'active' where id = any($1::uuid[])",
			[[certifierA, certifierB, certifierShared]],
		);
		await pool.query("update certifiers set status = 'blocked' where id = $1", [
			certifierBlocked,
		]);
	});

	afterAll(async () => {
		if (!pool) return;

		const client = await pool.connect();
		try {
			await client.query(
				"delete from wp_certifier_authorizations where certifier_id = any($1::uuid[])",
				[[certifierA, certifierB, certifierShared, certifierBlocked]],
			);
			await client.query("delete from certifiers where id = any($1::uuid[])", [
				[certifierA, certifierB, certifierShared, certifierBlocked],
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

	describe("reads", () => {
		it("shows every WP role the certifiers authorized for their own purveyor", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await rowsFor(
					reader,
					"select id from certifiers where id = any($1::uuid[]) order by id",
					[[certifierA, certifierB, certifierShared]],
				);

				expect(rows.map((row) => row.id).sort()).toEqual(
					[certifierA, certifierShared].sort(),
				);
			}
		});

		it("returns nothing when a WP role names the other tenant's certifier directly", async () => {
			// The guessed-id case. `USING` decides which rows exist for this caller,
			// so naming one changes nothing.
			const rows = await rowsFor(
				ids.adminA,
				"select id from certifiers where id = $1",
				[certifierB],
			);

			expect(rows).toHaveLength(0);
		});

		it("shows a shared certifier to both purveyors", async () => {
			for (const reader of [ids.adminA, ids.adminB]) {
				const rows = await rowsFor(
					reader,
					"select id from certifiers where id = $1",
					[certifierShared],
				);

				expect(rows).toHaveLength(1);
			}
		});

		it("shows a certifier their own row and nobody else's", async () => {
			const rows = await rowsFor(
				ids.certifierAProfile,
				"select id from certifiers where id = any($1::uuid[])",
				[[certifierA, certifierB, certifierShared]],
			);

			expect(rows.map((row) => row.id)).toEqual([certifierA]);
		});

		it("shows every tenant's certifiers to a Super-Admin", async () => {
			const rows = await rowsFor(
				ids.superAdmin,
				"select id from certifiers where id = any($1::uuid[])",
				[[certifierA, certifierB, certifierShared]],
			);

			expect(rows.map((row) => row.id).sort()).toEqual(
				[certifierA, certifierB, certifierShared].sort(),
			);
		});

		it("gives a blocked profile nothing, even inside its own purveyor", async () => {
			const rows = await rowsFor(
				ids.blockedAdminA,
				"select id from certifiers",
			);

			expect(rows).toHaveLength(0);
		});
	});

	describe("writes", () => {
		const blockA =
			"update certifiers set status = 'blocked' where id = $1 returning status";

		it("refuses a WP Admin and SubAdmin the account-wide status (0023)", async () => {
			// A purveyor's block is its own authorization row now. Writing
			// `certifiers.status` would lock the certifier out of every other
			// purveyor, so no WP UPDATE policy exists and the write matches nothing.
			for (const writer of [ids.adminA, ids.subAdminA]) {
				const rows = await rowsFor(writer, blockA, [certifierA]);

				expect(rows).toHaveLength(0);
			}
		});

		it("refuses a WP Employee the status write, while still letting them read", async () => {
			// `certifiers_select_own_wp` covers all three roles, and no WP role has
			// an UPDATE policy. The row is visible, so the update matches it under
			// no policy and writes nothing.
			const read = await rowsFor(
				ids.employeeA,
				"select id from certifiers where id = $1",
				[certifierA],
			);
			expect(read).toHaveLength(1);

			const written = await rowsFor(ids.employeeA, blockA, [certifierA]);
			expect(written).toHaveLength(0);
		});

		it("refuses a WP role updating the other tenant's certifier", async () => {
			const rows = await rowsFor(ids.adminA, blockA, [certifierB]);

			// The row is invisible under USING, so the update matches nothing rather
			// than raising — a silent no-op is the correct answer, and the procedure
			// turns it into a not-found.
			expect(rows).toHaveLength(0);
		});

		it("does not let either purveyor block a certifier they share account-wide", async () => {
			for (const writer of [ids.adminA, ids.adminB]) {
				const rows = await rowsFor(writer, blockA, [certifierShared]);

				expect(rows).toHaveLength(0);
			}
		});

		it("refuses a blocked profile the status write", async () => {
			const rows = await rowsFor(ids.blockedAdminA, blockA, [certifierA]);

			expect(rows).toHaveLength(0);
		});

		it("gives nobody a way to insert or delete a certifier, Super-Admin included", async () => {
			// A `certifiers` row is created by invite redemption through the
			// privileged connection, and nothing in the product removes one.
			// `certifiers_all_super_admin` is written `FOR ALL`, which looks like it
			// covers both — it does, as a policy, and it still gets nowhere, because
			// the grant never handed the privilege over.
			for (const writer of [ids.adminA, ids.superAdmin]) {
				await expect(
					rowsFor(
						writer,
						`insert into certifiers (profile_id, company, id_number, license_expiration_date, status)
						 values ($1, 'Forged', 'LIC-X', '2030-01-01', 'active')`,
						[ids.adminB],
					),
				).rejects.toThrow(/permission denied/i);

				await expect(
					rowsFor(writer, "delete from certifiers where id = $1", [certifierA]),
				).rejects.toThrow(/permission denied/i);
			}
		});
	});

	/**
	 * Column permissions — the three-actor model from `0007`.
	 *
	 * `0006` capped the whole `authenticated` role at `status`, which was the
	 * wrong reach: PostgREST hands every signed-in user of this application the
	 * same Postgres role, so capping it capped the Super-Admin and the certifier
	 * too. `0007` widens the grant to the union of the writable business columns
	 * and moves the per-actor narrowing into a BEFORE UPDATE trigger, the only
	 * object able to see both the old row and the new one.
	 *
	 * That makes the trigger load-bearing rather than decorative: a WP role now
	 * *holds* the grant on `company`, and the only thing between it and a
	 * rewritten licence number is `private.enforce_certifier_column_permissions`.
	 * Every case below is asserted for that reason.
	 */
	describe("column permissions", () => {
		const setCompany =
			"update certifiers set company = 'Rewritten' where id = $1 returning company";
		const setIdNumber =
			"update certifiers set id_number = 'LIC-FORGED' where id = $1 returning id_number";
		const setExpiry =
			"update certifiers set license_expiration_date = '2099-01-01' where id = $1 returning license_expiration_date";
		const PROFILE_WRITES = [setCompany, setIdNumber, setExpiry];

		describe("WP Admin and SubAdmin — no column at all (0023)", () => {
			it("refuses every professional column and the status", async () => {
				// 0023 dropped the WP UPDATE policy, so these match no row before
				// the 0007 trigger is ever reached.
				for (const writer of [ids.adminA, ids.subAdminA]) {
					for (const statement of [
						...PROFILE_WRITES,
						"update certifiers set status = 'blocked' where id = $1 returning status",
					]) {
						expect(await rowsFor(writer, statement, [certifierA])).toHaveLength(
							0,
						);
					}
				}
			});

			it("gives a WP Employee neither column", async () => {
				// No UPDATE policy at all, so the write matches no row rather than
				// reaching the trigger.
				for (const statement of PROFILE_WRITES) {
					expect(
						await rowsFor(ids.employeeA, statement, [certifierA]),
					).toHaveLength(0);
				}
			});

			it("does not let a WP write a professional column in another tenant either", async () => {
				expect(
					await rowsFor(ids.adminA, setCompany, [certifierB]),
				).toHaveLength(0);
			});
		});

		describe("certifier — their own record, never their own status", () => {
			it("lets a certifier maintain their own professional fields", async () => {
				expect(
					await rowsFor(ids.certifierAProfile, setCompany, [certifierA]),
				).toEqual([{ company: "Rewritten" }]);
				expect(
					await rowsFor(ids.certifierAProfile, setIdNumber, [certifierA]),
				).toEqual([{ id_number: "LIC-FORGED" }]);
				expect(
					await rowsFor(ids.certifierAProfile, setExpiry, [certifierA]),
				).toHaveLength(1);
			});

			it("refuses a certifier their own status", async () => {
				await expect(
					rowsFor(
						ids.certifierAProfile,
						"update certifiers set status = 'blocked' where id = $1",
						[certifierA],
					),
				).rejects.toThrow(/cannot change their own status/i);
			});

			it("gives a blocked certifier no way to unblock themselves", async () => {
				// Closed a layer earlier than the trigger: the self UPDATE policy
				// resolves the role through `private.current_global_role()`, which is
				// NULL once they are blocked, so there is no row to update. Writing
				// `status = 'active'` on an already-active row would not be a status
				// change at all, which is why this case needs a genuinely blocked one.
				expect(
					await rowsFor(
						ids.certifierBlockedProfile,
						"update certifiers set status = 'active' where id = $1 returning status",
						[certifierBlocked],
					),
				).toHaveLength(0);
			});

			it("gives a blocked certifier no way to edit their own record either", async () => {
				expect(
					await rowsFor(ids.certifierBlockedProfile, setCompany, [
						certifierBlocked,
					]),
				).toHaveLength(0);
			});

			it("still lets a blocked certifier read their own row", async () => {
				// So "why can I not sign in" has an answer. The self SELECT policy
				// from `0006` is keyed on `auth.uid()` alone, deliberately.
				expect(
					await rowsFor(
						ids.certifierBlockedProfile,
						"select status from certifiers where id = $1",
						[certifierBlocked],
					),
				).toEqual([{ status: "blocked" }]);
			});

			it("gives a certifier no reach into another certifier's record", async () => {
				for (const statement of PROFILE_WRITES) {
					expect(
						await rowsFor(ids.certifierAProfile, statement, [certifierB]),
					).toHaveLength(0);
				}
			});
		});

		describe("Super-Admin — full", () => {
			it("writes every business column, including the ones a WP cannot", async () => {
				for (const statement of PROFILE_WRITES) {
					expect(
						await rowsFor(ids.superAdmin, statement, [certifierA]),
					).toHaveLength(1);
				}

				expect(
					await rowsFor(
						ids.superAdmin,
						"update certifiers set status = 'blocked' where id = $1 returning status",
						[certifierA],
					),
				).toEqual([{ status: "blocked" }]);
			});

			it("writes across tenants", async () => {
				expect(
					await rowsFor(ids.superAdmin, setCompany, [certifierB]),
				).toHaveLength(1);
			});
		});

		it("keeps the identity columns out of everybody's reach", async () => {
			// `id` and `profile_id` are in no grant. `profile_id` is the link to the
			// `auth.users` account whose session becomes this certifier — a client
			// able to rewrite it could point an existing licence number at a
			// different person.
			for (const writer of [
				ids.adminA,
				ids.superAdmin,
				ids.certifierAProfile,
			]) {
				await expect(
					rowsFor(
						writer,
						"update certifiers set profile_id = $2 where id = $1",
						[certifierA, ids.certifierBProfile],
					),
				).rejects.toThrow(/permission denied|cannot be changed/i);
			}
		});
	});

	describe("a blocked certifier keeps no access", () => {
		it("resolves to no role at all, so every role-scoped policy closes", async () => {
			// `certifiers.status` is folded into `private.current_global_role()` by
			// `0006`, so blocking a certifier costs them the same thing blocking
			// their profile would. Asserted through `repair_companies`, a table with
			// policies that turn entirely on the resolved role — the point is that
			// the loss is not local to `certifiers`.
			await asUser(ids.certifierSharedProfile, async (client) => {
				const before = await client.query(
					"select private.current_global_role() as role",
				);
				expect(before.rows[0]?.role).toBe("certifier");
			});

			await pool.query(
				"update certifiers set status = 'blocked' where id = $1",
				[certifierShared],
			);

			try {
				await asUser(ids.certifierSharedProfile, async (client) => {
					const after = await client.query(
						"select private.current_global_role() as role, private.current_wp_id() as wp",
					);
					expect(after.rows[0]?.role).toBeNull();
					expect(after.rows[0]?.wp).toBeNull();
				});
			} finally {
				await pool.query(
					"update certifiers set status = 'active' where id = $1",
					[certifierShared],
				);
			}
		});

		it("does not disturb a WP caller, who has no certifier row at all", async () => {
			// The NOT EXISTS in the helper has to leave every non-certifier profile
			// untouched — a bug there would log the whole product out.
			await asUser(ids.adminA, async (client) => {
				const result = await client.query(
					"select private.current_global_role() as role, private.current_wp_id() as wp",
				);
				expect(result.rows[0]?.role).toBe("wp_admin");
				expect(result.rows[0]?.wp).toBe(wpA);
			});
		});
	});
});
