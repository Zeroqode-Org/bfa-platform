/**
 * Opt-in gate for the database-backed test suites.
 *
 * These suites talk to a real Postgres and write real rows. That is the point —
 * RLS policies cannot be verified any other way — but it also means a plain
 * `npm test` must not touch anybody's database. So they run only when
 * `RUN_DB_TESTS=1` is set deliberately, via `npm run test:db`; without it they
 * report as skipped and the default run stays offline.
 *
 * `npm run test:db` (`scripts/run-db-tests.mjs`) is the only supported way to
 * set that flag. It resolves **`TEST_DATABASE_URL`** — never the development
 * `DATABASE_URL`, and it refuses a URL that names the same database — then
 * bootstraps and migrates that target and hands it to the child process as its
 * `DATABASE_URL`. So by the time a suite reads the variable below, it is the
 * dedicated test database or the run never started. See the docs page
 * "Database Baseline & Test Isolation".
 *
 * Deliberately imports nothing: it is read by suites in two packages, and a
 * shared gate that drags a test framework into `packages/db`'s dependency list
 * would cost more than it saves.
 */

export const DB_TESTS_ENABLED = process.env.RUN_DB_TESTS === "1";

/**
 * The connection string for the opted-in run — the test database the runner
 * resolved and migrated. Throws rather than skipping when the flag is set but
 * no URL arrived: somebody asked for these tests, and silently running none of
 * them is the wrong answer to a missing variable.
 */
export function requireDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		throw new Error(
			"RUN_DB_TESTS=1 but no DATABASE_URL is set. Run the database suites " +
				"through `npm run test:db` with TEST_DATABASE_URL configured — the " +
				"runner supplies the test database to this process.",
		);
	}

	return databaseUrl;
}
