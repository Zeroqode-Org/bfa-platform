import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Runs the test suite with the database-backed suites switched on.
 *
 * A wrapper rather than `RUN_DB_TESTS=1 vitest run` in the npm script, because
 * that prefix syntax is a POSIX shell feature and npm runs scripts through
 * `cmd.exe` on Windows, where it is a syntax error. Everything after
 * `npm run test:db` is forwarded to Vitest, so `npm run test:db -- rls` still
 * filters the way it would normally.
 *
 * `EMAIL_DRIVER` is forced to `console` for the child process, whatever the
 * developer's shell or `apps/web/.env.local` says. The suites send invitation
 * and broadcast mail to fixture addresses (`@example.com`), and a local
 * `EMAIL_DRIVER=provider` would otherwise hand them to Resend — attempting real
 * delivery, and failing tests that have nothing to do with delivery. The
 * override is set before Vitest starts, and `vitest.setup.ts` loads
 * `.env.local` with dotenv's default of not overwriting variables that are
 * already set, so the file's `DATABASE_URL` still applies while its email
 * driver does not. Only this script sets it: `npm test`, the app and
 * production read `EMAIL_DRIVER` as configured.
 */
const require = createRequire(import.meta.url);
const vitestBin = require.resolve("vitest/vitest.mjs");

const child = spawn(
	process.execPath,
	[vitestBin, "run", ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: { ...process.env, RUN_DB_TESTS: "1", EMAIL_DRIVER: "console" },
	},
);

child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 1));
});
