/**
 * The environment contract for `npm run test:db`, as pure functions.
 *
 * Separated from `run-db-tests.mjs` so the rules — where the test connection
 * string may come from, and when a run must be refused — are unit-testable
 * offline (`packages/db/src/testing/db-test-env.test.ts`) instead of being
 * provable only by pointing the runner at real databases.
 *
 * The contract:
 *
 * - The database-backed suites connect to **`TEST_DATABASE_URL`** and nothing
 *   else. It comes from the shell, or from `apps/web/.env.local` — but only
 *   that one key is read from the file. The development `DATABASE_URL` is
 *   never used as a fallback: the whole point of the split is that a test run
 *   cannot write into the database `npm run dev` is using, and a fallback
 *   would quietly rebuild exactly that.
 * - A missing `TEST_DATABASE_URL` is a refusal with instructions, not a
 *   degraded run.
 * - A `TEST_DATABASE_URL` that names the same server *and the same database*
 *   as the development `DATABASE_URL` is refused too. Forcing
 *   `SCHEDULER_ENABLED=false` inside the test process cannot protect fixtures
 *   from a dev server that is already running against that database, so the
 *   isolation has to be a different database, not a different flag.
 */

/**
 * Reads one `KEY=value` assignment out of dotenv-style file text. Handles the
 * shapes that file actually contains — optional surrounding quotes, CRLF,
 * comments — without pulling in a parser that would happily hand back every
 * other secret in the file too.
 */
export function readEnvKey(text, key) {
	if (!text) return undefined;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();

		if (line.startsWith("#")) continue;

		const eq = line.indexOf("=");
		if (eq === -1 || line.slice(0, eq).trim() !== key) continue;

		let value = line.slice(eq + 1).trim();

		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}

		return value === "" ? undefined : value;
	}

	return undefined;
}

/** postgres:// and postgresql:// are the same thing; the URL parser needs one. */
function parseDatabaseUrl(value) {
	try {
		const url = new URL(value);

		if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
			return null;
		}

		return url;
	} catch {
		return null;
	}
}

/**
 * Whether two connection strings name the same database: same host, same
 * port (5432 when omitted), same database name. Credentials and query
 * parameters are ignored — a different password is still the same rows, and
 * `?sslmode=` does not make a database a different one. Unparseable input
 * compares as text, so two identical malformed strings are still caught.
 */
export function sameDatabase(a, b) {
	const urlA = parseDatabaseUrl(a);
	const urlB = parseDatabaseUrl(b);

	if (!urlA || !urlB) return a === b;

	return (
		urlA.hostname.toLowerCase() === urlB.hostname.toLowerCase() &&
		(urlA.port || "5432") === (urlB.port || "5432") &&
		urlA.pathname === urlB.pathname
	);
}

/**
 * Resolves the two URLs the runner cares about. `TEST_DATABASE_URL` and
 * `DATABASE_URL` each come from the process environment first, then from the
 * given `.env.local` text — and the development URL is resolved *only* to be
 * compared against, never to be connected to.
 */
export function resolveDbTestEnv({ processEnv = {}, envLocalText = "" } = {}) {
	const fromEnv = (key) => {
		const value = processEnv[key];

		return typeof value === "string" && value.trim() !== ""
			? value.trim()
			: undefined;
	};

	return {
		testUrl:
			fromEnv("TEST_DATABASE_URL") ??
			readEnvKey(envLocalText, "TEST_DATABASE_URL"),
		devUrl: fromEnv("DATABASE_URL") ?? readEnvKey(envLocalText, "DATABASE_URL"),
	};
}

export const MISSING_TEST_URL_MESSAGE = [
	"npm run test:db needs TEST_DATABASE_URL, and it is not set.",
	"",
	"The database-backed suites write real rows, apply migrations, and assume",
	"they own every table — so they refuse to run against the development",
	"DATABASE_URL. Point TEST_DATABASE_URL at a disposable database instead:",
	"",
	"  - a local PostgreSQL (connect as the superuser, e.g.",
	"    postgres://postgres:...@localhost:5432/bfa_test) — the runner creates",
	"    the API roles and an auth.uid() shim itself and applies migrations;",
	"  - `supabase start` (Docker) or a Supabase branch / spare project.",
	"",
	'Set it in the shell or add TEST_DATABASE_URL="..." to apps/web/.env.local',
	"(only that key is read for the test connection).",
].join("\n");

export const SAME_DATABASE_MESSAGE = [
	"TEST_DATABASE_URL points at the same database as the development",
	"DATABASE_URL — refusing to run.",
	"",
	"Test runs migrate the target and write real rows, and a dev server running",
	"against that database (SCHEDULER_ENABLED=true ticks every minute) rewrites",
	"test fixtures mid-run. Disabling the scheduler inside the test process",
	"cannot protect against a server that is already running, so the test",
	"database has to be a different one, not the same one with different flags.",
].join("\n");

/**
 * The go/no-go decision. Returns the URL to use, or throws with the exact
 * message the developer should see.
 */
export function requireTestDatabaseUrl({ testUrl, devUrl }) {
	if (!testUrl) {
		throw new Error(MISSING_TEST_URL_MESSAGE);
	}

	if (devUrl && sameDatabase(testUrl, devUrl)) {
		throw new Error(SAME_DATABASE_MESSAGE);
	}

	return testUrl;
}
