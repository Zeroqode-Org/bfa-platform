/**
 * Opt-in gate for the database-backed test suites.
 *
 * These suites talk to a real Postgres and write real rows. That is the point —
 * RLS policies cannot be verified any other way — but it also means a plain
 * `npm test` must not touch anybody's database. So they run only when
 * `RUN_DB_TESTS=1` is set deliberately, via `npm run test:db`; without it they
 * report as skipped and the default run stays offline.
 *
 * Deliberately imports nothing: it is read by suites in two packages, and a
 * shared gate that drags a test framework into `packages/db`'s dependency list
 * would cost more than it saves.
 */

export const DB_TESTS_ENABLED = process.env.RUN_DB_TESTS === "1";

/**
 * The connection string for the opted-in run. Throws rather than skipping when
 * the flag is set but no URL is configured — somebody asked for these tests, and
 * silently running none of them is the wrong answer to a missing variable.
 */
export function requireDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		throw new Error(
			"RUN_DB_TESTS=1 but DATABASE_URL is not set. Put it in apps/web/.env.local, or export it, then run `npm run test:db`.",
		);
	}

	return databaseUrl;
}
