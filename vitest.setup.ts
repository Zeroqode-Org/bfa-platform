import { existsSync } from "node:fs";
import { resolve } from "node:path";

import dotenv from "dotenv";

/**
 * Local credentials are loaded only for an opted-in database run.
 *
 * A plain `npm test` must not reach a network or a database, so it must not go
 * looking for anybody's `.env.local` either — reading it is what would let a
 * suite quietly connect to a shared Supabase project. `npm run test:db` sets
 * `RUN_DB_TESTS=1`, and only then is the same file `packages/db/src/seed.ts`
 * reads brought in.
 *
 * An explicit `DATABASE_URL` in the environment wins: `dotenv` does not
 * overwrite variables that are already set.
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
	const envFile = resolve(process.cwd(), "apps/web/.env.local");

	if (existsSync(envFile)) {
		dotenv.config({ path: envFile, quiet: true });
	}
}
