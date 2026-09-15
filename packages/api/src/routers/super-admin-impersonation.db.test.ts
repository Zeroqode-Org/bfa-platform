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
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

/**
 * Super-Admin impersonation against real Postgres: which account a purveyor
 * resolves to, and that a live change to that account or its purveyor ends the
 * impersonation on the very next request.
 *
 * The offline suite (`super-admin-impersonation.test.ts`) covers the procedure
 * and cookie rules with a stand-in database. This one exists for what only the
 * real queries can prove — the ordering, the role and status filters, the join
 * through `water_purveyors` — so it seeds a purveyor with several admins and
 * every other WP role alongside them.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const SECRET = "db-suite-impersonation-secret-0123456789";

const wpActive = randomUUID();
const wpBlocked = randomUUID();
const wpNoAdmin = randomUUID();
const ids = {
	superAdmin: randomUUID(),
	firstAdmin: randomUUID(),
	laterAdmin: randomUUID(),
	subAdmin: randomUUID(),
	employee: randomUUID(),
	blockedWpAdmin: randomUUID(),
	noAdminBlockedAdmin: randomUUID(),
	noAdminEmployee: randomUUID(),
};

let pool: pg.Pool;

type Probe = {
	superAdmin: {
		startImpersonation: (input: { waterPurveyorId: string }) => Promise<{
			waterPurveyorId: string;
			waterPurveyorName: string | null;
		}>;
		endImpersonation: () => Promise<{ ended: boolean }>;
	};
	repairCompanies: {
		createRepairCompany: (input: { companyName: string }) => Promise<{
			id: string;
		}>;
	};
	session: {
		clearImpersonation: (input: {
			reason: "sign_out" | "sign_in";
		}) => Promise<{ cleared: boolean }>;
	};
	whoami: () => Promise<{
		profileId: string;
		globalRole: string;
		waterPurveyorId: string | null;
		impersonating: boolean;
	}>;
};

/** Two distinct Supabase Auth sessions of the same Super-Admin. */
const SESSION = randomUUID();
const LATER_SESSION = randomUUID();

let callerFor: (
	profileId: string,
	impersonationToken?: string | null,
	authSessionId?: string | null,
) => { api: Probe; resHeaders: Headers };

/** The structured log lines emitted during the current test, for one event. */
function loggedEvents(event: string) {
	return vi
		.mocked(console.log)
		.mock.calls.map(([line]) => JSON.parse(String(line)))
		.filter((entry) => entry.event === event);
}

/** The impersonation cookie value a response set, or undefined. */
function cookieSetBy(headers: Headers) {
	for (const line of headers.getSetCookie()) {
		const match = line.match(/^bfa_impersonation=([^;]*)/);
		if (match) return match[1];
	}
	return undefined;
}

describeDb("Super-Admin impersonation (database)", () => {
	beforeAll(async () => {
		vi.stubEnv("IMPERSONATION_COOKIE_SECRET", SECRET);
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const { t } = await import("../index");
		const { appRouter } = await import("./index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (
			profileId,
			impersonationToken = null,
			authSessionId = SESSION,
		) => {
			const resHeaders = new Headers();
			const api = createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				authSessionId,
				resHeaders,
				impersonationToken,
			}) as unknown as Probe;
			return { api, resHeaders };
		};

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Impersonation Fixture Active', 'IMP-A', 'active'),
			        ($2, 'Impersonation Fixture Blocked', 'IMP-B', 'blocked'),
			        ($3, 'Impersonation Fixture No Admin', 'IMP-C', 'active')`,
			[wpActive, wpBlocked, wpNoAdmin],
		);

		// Explicit created_at so "earliest admin" is a fact of the fixture rather
		// than of insert timing. The sub-admin and employee are older still: they
		// must never be chosen however early they were created.
		const profileRows: [string, string | null, string, string, string][] = [
			[ids.superAdmin, null, "super_admin", "active", "2026-01-01"],
			[ids.subAdmin, wpActive, "wp_sub_admin", "active", "2026-01-01"],
			[ids.employee, wpActive, "wp_employee", "active", "2026-01-01"],
			[ids.firstAdmin, wpActive, "wp_admin", "active", "2026-02-01"],
			[ids.laterAdmin, wpActive, "wp_admin", "active", "2026-03-01"],
			[ids.blockedWpAdmin, wpBlocked, "wp_admin", "active", "2026-02-01"],
			[ids.noAdminBlockedAdmin, wpNoAdmin, "wp_admin", "blocked", "2026-02-01"],
			[ids.noAdminEmployee, wpNoAdmin, "wp_employee", "active", "2026-02-01"],
		];

		for (const [id, wp, role, status, createdAt] of profileRows) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status, created_at)
				 values ($1, $2, 'Impersonation Fixture', $3::global_role, $4, $5)`,
				[id, wp, role, status, createdAt],
			);
		}
	});

	beforeEach(async () => {
		await pool.query(
			"update profiles set status = 'active' where id = any($1::uuid[])",
			[[ids.firstAdmin, ids.laterAdmin]],
		);
		await pool.query(
			"update water_purveyors set status = 'active' where id = $1",
			[wpActive],
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.mocked(console.log).mockRestore();
	});

	afterAll(async () => {
		vi.unstubAllEnvs();
		if (!pool) return;

		await pool.query(
			"delete from repair_companies where water_purveyor_id = any($1::uuid[])",
			[[wpActive, wpBlocked, wpNoAdmin]],
		);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpActive, wpBlocked, wpNoAdmin],
		]);
		await pool.end();
	});

	async function start(waterPurveyorId = wpActive) {
		const { api, resHeaders } = callerFor(ids.superAdmin);
		await api.superAdmin.startImpersonation({ waterPurveyorId });
		const token = cookieSetBy(resHeaders);
		expect(token).toBeTruthy();
		return token as string;
	}

	it("becomes the purveyor's earliest active wp_admin, never a sub-admin or employee", async () => {
		const token = await start();

		await expect(
			callerFor(ids.superAdmin, token).api.whoami(),
		).resolves.toEqual({
			profileId: ids.firstAdmin,
			globalRole: "wp_admin",
			waterPurveyorId: wpActive,
			impersonating: true,
		});
	});

	it("skips a blocked admin in favour of the next active one", async () => {
		await pool.query("update profiles set status = 'blocked' where id = $1", [
			ids.firstAdmin,
		]);

		const token = await start();

		await expect(
			callerFor(ids.superAdmin, token).api.whoami(),
		).resolves.toMatchObject({ profileId: ids.laterAdmin });
	});

	it("refuses a blocked purveyor and a purveyor with no active admin", async () => {
		const { api } = callerFor(ids.superAdmin);

		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: wpBlocked }),
		).rejects.toThrow(/blocked water purveyor/i);
		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: wpNoAdmin }),
		).rejects.toThrow(/no active admin/i);
		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: randomUUID() }),
		).rejects.toThrow(/not found/i);
	});

	it("stops honouring the cookie as soon as the target is blocked", async () => {
		const token = await start();
		await pool.query("update profiles set status = 'blocked' where id = $1", [
			ids.firstAdmin,
		]);

		const { api, resHeaders } = callerFor(ids.superAdmin, token);

		await expect(api.whoami()).resolves.toMatchObject({
			profileId: ids.superAdmin,
			globalRole: "super_admin",
			impersonating: false,
		});
		// And the response clears it.
		expect(cookieSetBy(resHeaders)).toBe("");
	});

	it("stops honouring the cookie as soon as the purveyor is blocked", async () => {
		const token = await start();
		await pool.query(
			"update water_purveyors set status = 'blocked' where id = $1",
			[wpActive],
		);

		await expect(
			callerFor(ids.superAdmin, token).api.whoami(),
		).resolves.toMatchObject({
			globalRole: "super_admin",
			impersonating: false,
		});
	});

	it("does nothing for a WP admin who presents a Super-Admin's cookie", async () => {
		const token = await start();

		await expect(
			callerFor(ids.laterAdmin, token).api.whoami(),
		).resolves.toMatchObject({
			profileId: ids.laterAdmin,
			impersonating: false,
		});
	});

	it("attributes a WP change made while impersonating to the real Super-Admin", async () => {
		const token = await start();

		const created = await callerFor(
			ids.superAdmin,
			token,
		).api.repairCompanies.createRepairCompany({
			companyName: "Impersonation Audit Repairs",
		});

		// Written into the impersonated purveyor…
		const { rows } = await pool.query(
			"select water_purveyor_id from repair_companies where id = $1",
			[created.id],
		);
		expect(rows[0]?.water_purveyor_id).toBe(wpActive);

		// …but attributed to the person who actually did it.
		expect(loggedEvents("repair_company_created")).toEqual([
			expect.objectContaining({
				actor_id: ids.superAdmin,
				effective_profile_id: ids.firstAdmin,
				repair_company_id: created.id,
				wp_id: wpActive,
			}),
		]);
	});

	it("signing out clears the cookie, so signing back in does not resume the impersonation", async () => {
		const token = await start();
		const { api, resHeaders } = callerFor(ids.superAdmin, token);

		await expect(
			api.session.clearImpersonation({ reason: "sign_out" }),
		).resolves.toEqual({ cleared: true });
		expect(cookieSetBy(resHeaders)).toBe("");
		expect(loggedEvents("impersonation_ended")).toEqual([
			expect.objectContaining({
				actor_id: ids.superAdmin,
				target_profile_id: ids.firstAdmin,
				wp_id: wpActive,
				reason: "sign_out",
			}),
		]);

		// The browser dropped the cookie, so the next session carries none.
		await expect(callerFor(ids.superAdmin).api.whoami()).resolves.toMatchObject(
			{
				profileId: ids.superAdmin,
				globalRole: "super_admin",
				impersonating: false,
			},
		);
	});

	it("ignores the cookie in a later auth session, even when nothing ever deleted it", async () => {
		// Sign-out's clear and sign-in's clear both failed: the browser still
		// holds the cookie, and now a new Supabase session for the same person.
		const token = await start();

		const { api, resHeaders } = callerFor(ids.superAdmin, token, LATER_SESSION);

		await expect(api.whoami()).resolves.toMatchObject({
			profileId: ids.superAdmin,
			globalRole: "super_admin",
			impersonating: false,
		});
		expect(cookieSetBy(resHeaders)).toBe("");
		expect(loggedEvents("impersonation_cookie_rejected")).toEqual([
			expect.objectContaining({
				actor_id: ids.superAdmin,
				reason: "session_mismatch",
			}),
		]);

		// And the session that started it still sees the impersonation.
		await expect(
			callerFor(ids.superAdmin, token, SESSION).api.whoami(),
		).resolves.toMatchObject({
			profileId: ids.firstAdmin,
			impersonating: true,
		});
	});

	it("restores the Super-Admin after ending", async () => {
		const token = await start();
		const { api, resHeaders } = callerFor(ids.superAdmin, token);

		await expect(api.superAdmin.endImpersonation()).resolves.toEqual({
			ended: true,
		});
		expect(cookieSetBy(resHeaders)).toBe("");

		await expect(callerFor(ids.superAdmin).api.whoami()).resolves.toMatchObject(
			{
				profileId: ids.superAdmin,
				globalRole: "super_admin",
				impersonating: false,
			},
		);
	});
});
