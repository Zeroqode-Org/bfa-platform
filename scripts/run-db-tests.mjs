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
 */
const require = createRequire(import.meta.url);
const vitestBin = require.resolve("vitest/vitest.mjs");

const child = spawn(
	process.execPath,
	[vitestBin, "run", ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: { ...process.env, RUN_DB_TESTS: "1" },
	},
);

child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 1));
});
