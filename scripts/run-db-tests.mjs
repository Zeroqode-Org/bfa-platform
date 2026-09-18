import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireTestDatabaseUrl, resolveDbTestEnv } from "./db-test-env.mjs";

/**
 * Runs the test suite with the database-backed suites switched on — against a
 * dedicated test database, never the development one.
 *
 * A wrapper rather than `RUN_DB_TESTS=1 vitest run` in the npm script, because
 * that prefix syntax is a POSIX shell feature and npm runs scripts through
 * `cmd.exe` on Windows, where it is a syntax error. Everything after
 * `npm run test:db` is forwarded to Vitest, so `npm run test:db -- rls` still
 * filters the way it would normally.
 *
 * What one run does, in order:
 *
 * 1. **Resolves `TEST_DATABASE_URL`** (shell first, then that one key from
 *    `apps/web/.env.local`) and refuses to start without it, or when it names
 *    the same database as the development `DATABASE_URL`. The rules and their
 *    error text live in `db-test-env.mjs`, where they are unit-tested; the
 *    reasoning is written up in the docs page "Database Baseline & Test
 *    Isolation". The development URL is resolved only for that comparison —
 *    this process never connects to it.
 * 2. **Bootstraps a bare target.** The suites impersonate PostgREST callers
 *    (`set local role authenticated`) and the policies call `auth.uid()`, so
 *    the target must look Supabase-shaped. On a Supabase database everything
 *    already exists and this step verifies-and-skips; on a plain PostgreSQL it
 *    creates the three NOLOGIN API roles and a faithful `auth.uid()` shim, so
 *    "an empty local database" is a sufficient prerequisite.
 * 3. **Applies `packages/db`'s migrations** to the test database, so every run
 *    executes against the current schema — which also makes each run a proof
 *    that a clean database built from migration history alone passes the RLS
 *    and privilege-baseline suites. The development database is never migrated
 *    from here.
 * 4. **Spawns Vitest** with the environment pinned:
 *      - `DATABASE_URL` = the test URL — the only database the child knows;
 *      - `RUN_DB_TESTS=1` — what un-skips the database suites;
 *      - `EMAIL_DRIVER=console` — fixture addresses must never reach Resend;
 *      - `SCHEDULER_ENABLED=false` — no test process ever starts a tick loop.
 *    `vitest.setup.ts` still loads `apps/web/.env.local` for auxiliary
 *    configuration (Supabase keys for env validation), but restores these four
 *    afterwards, so nothing in that file can redirect a test run.
 */

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const require = createRequire(import.meta.url);

function envLocalText() {
	try {
		return readFileSync(resolve(repoRoot, "apps/web/.env.local"), "utf8");
	} catch {
		return "";
	}
}

let testUrl;
try {
	testUrl = requireTestDatabaseUrl(
		resolveDbTestEnv({ processEnv: process.env, envLocalText: envLocalText() }),
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

/**
 * Makes a bare PostgreSQL usable as the test target, idempotently.
 *
 * Everything is guarded on "does it already exist", so a Supabase-shaped
 * target — where `auth` belongs to `supabase_auth_admin` and must not be
 * touched — is left exactly as it is. The shim's `auth.uid()` is the same
 * definition Supabase ships: the `sub` claim of `request.jwt.claims`, which is
 * precisely what the RLS suites set with `set_config`.
 */
async function bootstrapTestDatabase(pool) {
	for (const role of ["anon", "authenticated", "service_role"]) {
		const { rows } = await pool.query(
			"select 1 from pg_roles where rolname = $1",
			[role],
		);

		if (rows.length === 0) {
			await pool.query(`create role "${role}" nologin`);
			console.log(`[test-db] created missing role ${role}`);
		}
	}

	const { rows: uid } = await pool.query(
		`select 1
		   from pg_proc p
		   join pg_namespace n on n.oid = p.pronamespace
		  where n.nspname = 'auth' and p.proname = 'uid'`,
	);

	if (uid.length === 0) {
		await pool.query("create schema if not exists auth");
		await pool.query(`
			create or replace function auth.uid()
			returns uuid
			language sql
			stable
			as $$
				select nullif(
					coalesce(
						nullif(current_setting('request.jwt.claim.sub', true), ''),
						current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
					),
					''
				)::uuid
			$$`);
		await pool.query(
			"grant usage on schema auth to anon, authenticated, service_role",
		);
		await pool.query(
			"grant execute on function auth.uid() to anon, authenticated, service_role",
		);
		console.log("[test-db] created auth.uid() shim");
	}
}

async function migrateTestDatabase() {
	const pg = require("pg");
	const { drizzle } = await import("drizzle-orm/node-postgres");
	const { migrate } = await import("drizzle-orm/node-postgres/migrator");

	const pool = new pg.Pool({ connectionString: testUrl, max: 1 });

	try {
		await bootstrapTestDatabase(pool);
		await migrate(drizzle(pool), {
			migrationsFolder: resolve(repoRoot, "packages/db/src/migrations"),
		});
		console.log("[test-db] migrations are current");
	} finally {
		await pool.end();
	}
}

try {
	await migrateTestDatabase();
} catch (error) {
	console.error(
		"[test-db] could not prepare the test database:",
		error instanceof Error ? error.message : String(error),
	);
	process.exit(1);
}

const vitestBin = require.resolve("vitest/vitest.mjs");

const child = spawn(
	process.execPath,
	[vitestBin, "run", ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: {
			...process.env,
			RUN_DB_TESTS: "1",
			DATABASE_URL: testUrl,
			EMAIL_DRIVER: "console",
			SCHEDULER_ENABLED: "false",
		},
	},
);

child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 1));
});
