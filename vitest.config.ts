import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * One suite for the whole monorepo.
 *
 * `npm test` runs the unit tests only: no network, no database, no credential
 * file read. The database-backed suites — RLS isolation, invite redemption and
 * `createInvitation` — write real rows, so they are opt-in behind
 * `npm run test:db`, which sets `RUN_DB_TESTS=1`. Without that flag they report
 * as skipped and `vitest.setup.ts` does not even look for `apps/web/.env.local`.
 *
 * Component tests opt into a DOM per file with `@vitest-environment jsdom`,
 * rather than the whole suite paying for one it mostly does not use.
 */
export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		setupFiles: ["./vitest.setup.ts"],
		include: [
			"packages/**/*.test.ts",
			"apps/web/**/*.test.ts",
			"apps/web/**/*.test.tsx",
		],
		exclude: [
			"**/node_modules/**",
			"**/.next/**",
			"**/dist/**",
			"prototype/**",
		],
		// Workspace packages export TypeScript source, so they must be transformed
		// rather than externalised the way a published dependency would be.
		server: { deps: { inline: [/@bfa-platform\//] } },
		// Both settings below exist for `npm run test:db` and cost the default
		// unit-only run nothing: the database suites share fixture rows, so running
		// their files in parallel would interleave inserts and deletes on them, and
		// every assertion in them is a round trip to a hosted Postgres, which a
		// handful of statements in one test comfortably outlasts at the 5s default.
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
	// `@/…` is `apps/web`'s own alias, declared in its tsconfig where Next reads
	// it. Vitest resolves modules itself, so it needs telling separately.
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
		},
	},
	// The React 17+ JSX runtime, matching `apps/web`'s `"jsx": "react-jsx"`.
	// Without it esbuild falls back to the classic transform and every component
	// file would need `React` in scope.
	esbuild: { jsx: "automatic" },
});
