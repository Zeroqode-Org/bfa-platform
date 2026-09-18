import { existsSync } from "node:fs";
import { resolve } from "node:path";

import dotenv from "dotenv";

/**
 * Local credentials are loaded only for an opted-in database run.
 *
 * A plain `npm test` must not reach a network or a database, so it must not go
 * looking for anybody's `.env.local` either — reading it is what would let a
 * suite quietly connect to a shared Supabase project. `npm run test:db` (via
 * `scripts/run-db-tests.mjs`) sets `RUN_DB_TESTS=1`, and only then is
 * `apps/web/.env.local` brought in at all.
 *
 * What it is brought in *for* is auxiliary configuration — the Supabase keys
 * the server env validation requires on import. The database connection is
 * never taken from it here: the runner resolves `TEST_DATABASE_URL`, refuses
 * the development database, and hands the child process its `DATABASE_URL`
 * along with `EMAIL_DRIVER=console` and `SCHEDULER_ENABLED=false`. Those
 * pinned values are captured before dotenv runs and restored after, so a
 * `.env.local` carrying the development `DATABASE_URL`, a live email driver
 * or `SCHEDULER_ENABLED=true` cannot redirect a test run — belt and braces on
 * top of dotenv's own no-overwrite default.
 *
 * Running the database suites without the runner is refused loudly: an
 * un-isolated `RUN_DB_TESTS=1 vitest` used to fall back to whatever
 * `DATABASE_URL` the file held, which is exactly the shared-database accident
 * this setup exists to prevent.
 */
// React needs telling it is inside a test renderer before it will accept
// `act()`; without it every component test logs a warning it cannot act on.
// Only meaningful in the jsdom files — the node suites have no `window`.
if (typeof window !== "undefined") {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
}

if (process.env.RUN_DB_TESTS === "1") {
	if (!process.env.DATABASE_URL) {
		throw new Error(
			"RUN_DB_TESTS=1 but no DATABASE_URL was provided by the runner. " +
				"Run the database suites through `npm run test:db` (with " +
				"TEST_DATABASE_URL set) — not by invoking Vitest directly.",
		);
	}

	const pinned = {
		DATABASE_URL: process.env.DATABASE_URL,
		EMAIL_DRIVER: process.env.EMAIL_DRIVER,
		SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
		TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
	};

	const envFile = resolve(process.cwd(), "apps/web/.env.local");

	if (existsSync(envFile)) {
		dotenv.config({ path: envFile, quiet: true });
	}

	for (const [key, value] of Object.entries(pinned)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
