/**
 * Types for `db-test-env.mjs`, which stays plain ESM so
 * `scripts/run-db-tests.mjs` can import it under bare Node with no build
 * step. The offline contract suite in
 * `packages/db/src/testing/db-test-env.test.ts` imports through these.
 */

export function readEnvKey(
	text: string | undefined,
	key: string,
): string | undefined;

export function sameDatabase(a: string, b: string): boolean;

export function resolveDbTestEnv(options?: {
	processEnv?: Record<string, string | undefined>;
	envLocalText?: string;
}): { testUrl: string | undefined; devUrl: string | undefined };

export const MISSING_TEST_URL_MESSAGE: string;
export const SAME_DATABASE_MESSAGE: string;

export function requireTestDatabaseUrl(resolved: {
	testUrl: string | undefined;
	devUrl: string | undefined;
}): string;
