import { describe, expect, it } from "vitest";

// The contract lives beside the runner as plain ESM so `run-db-tests.mjs` can
// import it without a build step; the suite reaches over to it so the rules
// are proven offline in `npm test` rather than only by pointing the runner at
// real databases.
import {
	MISSING_TEST_URL_MESSAGE,
	readEnvKey,
	requireTestDatabaseUrl,
	resolveDbTestEnv,
	SAME_DATABASE_MESSAGE,
	sameDatabase,
} from "../../../../scripts/db-test-env.mjs";

const DEV =
	"postgresql://postgres.ref:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres";
const TEST = "postgresql://postgres:secret@localhost:5432/bfa_test";

describe("readEnvKey", () => {
	it("reads a plain assignment", () => {
		expect(
			readEnvKey("TEST_DATABASE_URL=postgres://x/y", "TEST_DATABASE_URL"),
		).toBe("postgres://x/y");
	});

	// The real .env.local wraps its URL in double quotes — the exact shape that
	// once produced a connection attempt to a host called "base".
	it("strips surrounding quotes and CRLF", () => {
		expect(
			readEnvKey('TEST_DATABASE_URL="postgres://x/y"\r\n', "TEST_DATABASE_URL"),
		).toBe("postgres://x/y");
		expect(readEnvKey("KEY='v'\n", "KEY")).toBe("v");
	});

	it("reads only the named key, not comments or lookalikes", () => {
		const text = [
			"# TEST_DATABASE_URL=commented",
			"NOT_TEST_DATABASE_URL=other",
			"TEST_DATABASE_URL=real",
		].join("\n");

		expect(readEnvKey(text, "TEST_DATABASE_URL")).toBe("real");
	});

	it("treats an empty value as unset", () => {
		expect(
			readEnvKey("TEST_DATABASE_URL=", "TEST_DATABASE_URL"),
		).toBeUndefined();
		expect(
			readEnvKey('TEST_DATABASE_URL=""', "TEST_DATABASE_URL"),
		).toBeUndefined();
	});
});

describe("resolveDbTestEnv", () => {
	it("prefers the shell over the file, for both URLs", () => {
		const resolved = resolveDbTestEnv({
			processEnv: {
				TEST_DATABASE_URL: "shell-test",
				DATABASE_URL: "shell-dev",
			},
			envLocalText: 'TEST_DATABASE_URL="file-test"\nDATABASE_URL="file-dev"',
		});

		expect(resolved).toEqual({ testUrl: "shell-test", devUrl: "shell-dev" });
	});

	it("falls back to the file per key, and never crosses them", () => {
		const resolved = resolveDbTestEnv({
			processEnv: {},
			envLocalText: `DATABASE_URL="${DEV}"`,
		});

		// The development URL is resolved for the guard only. It must never
		// surface as the test URL.
		expect(resolved.testUrl).toBeUndefined();
		expect(resolved.devUrl).toBe(DEV);
	});

	it("ignores a blank shell value", () => {
		const resolved = resolveDbTestEnv({
			processEnv: { TEST_DATABASE_URL: "  " },
			envLocalText: `TEST_DATABASE_URL="${TEST}"`,
		});

		expect(resolved.testUrl).toBe(TEST);
	});
});

describe("sameDatabase", () => {
	it("matches the same host, port and database regardless of credentials or params", () => {
		expect(
			sameDatabase(
				"postgresql://a:one@db.example.com:6543/postgres?sslmode=require",
				"postgres://b:two@DB.EXAMPLE.COM:6543/postgres",
			),
		).toBe(true);
	});

	it("treats an omitted port as 5432", () => {
		expect(
			sameDatabase(
				"postgres://u@db.example.com/postgres",
				"postgres://u@db.example.com:5432/postgres",
			),
		).toBe(true);
	});

	it("says a different database on the same server is a different target", () => {
		expect(
			sameDatabase(
				"postgres://u@db.example.com:5432/postgres",
				"postgres://u@db.example.com:5432/bfa_test",
			),
		).toBe(false);
	});

	it("says a different server is a different target", () => {
		expect(sameDatabase(TEST, DEV)).toBe(false);
	});
});

describe("requireTestDatabaseUrl", () => {
	it("returns the test URL when it is set and distinct", () => {
		expect(requireTestDatabaseUrl({ testUrl: TEST, devUrl: DEV })).toBe(TEST);
	});

	it("refuses to run without TEST_DATABASE_URL, with instructions", () => {
		expect(() =>
			requireTestDatabaseUrl({ testUrl: undefined, devUrl: DEV }),
		).toThrow(MISSING_TEST_URL_MESSAGE);
	});

	// The heart of the isolation: the same connection string for both means a
	// running dev server could tick the tests' fixtures, so the run refuses
	// rather than degrading.
	it("refuses the development database, however it is spelled", () => {
		expect(() =>
			requireTestDatabaseUrl({
				testUrl: DEV.replace("postgresql://", "postgres://"),
				devUrl: DEV,
			}),
		).toThrow(SAME_DATABASE_MESSAGE);
	});

	it("allows a run when no development URL is configured at all", () => {
		expect(requireTestDatabaseUrl({ testUrl: TEST, devUrl: undefined })).toBe(
			TEST,
		);
	});
});
