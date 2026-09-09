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
if (process.env.RUN_DB_TESTS === "1") {
	const envFile = resolve(process.cwd(), "apps/web/.env.local");

	if (existsSync(envFile)) {
		dotenv.config({ path: envFile, quiet: true });
	}
}
