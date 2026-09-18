import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * No audit line may attribute an action to the effective caller alone.
 *
 * While a Super-Admin impersonates, `ctx.caller` is the purveyor admin they act
 * as. Writing `actor_id: ctx.caller.profileId` — or passing it on as an
 * `actorId` — would log the Super-Admin's change under somebody else's name.
 * Attribution goes through `auditActor(ctx)`, which keeps the real account in
 * `actor_id` and the borrowed one in `effective_profile_id`.
 *
 * Structural, like `apps/web/src/app/protected-pages.test.ts`, because the
 * failure mode is a *new* mutation written the old way, which no behavioural
 * test of today's procedures would catch.
 */

const API_SRC = fileURLToPath(new URL("..", import.meta.url));

function sourcesIn(directory: string) {
	return readdirSync(join(API_SRC, directory))
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.map((name) => ({
			path: `${directory}/${name}`,
			source: readFileSync(join(API_SRC, directory, name), "utf8"),
		}));
}

const files = [...sourcesIn("routers"), ...sourcesIn("lib")];

describe("audit attribution", () => {
	it("has sources to check", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	for (const { path, source } of files) {
		it(`${path} never attributes an action to ctx.caller`, () => {
			expect(source).not.toMatch(/actor(?:_id|Id)\s*:\s*ctx\.caller\b/);
		});

		// The helper itself declares and maps the field; it is what everything
		// else is checked against, not a call site.
		it.skipIf(path === "lib/audit-actor.ts")(
			`${path} writes actor_id only from the real actor`,
			() => {
				// Allowed: the helper's own mapping, `ctx.actor.profileId`, and the
				// invitation-redemption lines, where the new account is the actor.
				const offenders = [...source.matchAll(/actor_id:\s*([^,\n]+)/g)]
					.map((match) => match[1]?.trim() ?? "")
					.filter(
						(value) =>
							!value.startsWith("ctx.actor.") &&
							!value.startsWith("actor?.actorId") &&
							value !== "result.profileId" &&
							// session.ts: a verified cookie's own actor, checked against the session.
							value !== "verified.claims.actorProfileId" &&
							value !== "userId",
					);

				expect(offenders).toEqual([]);
			},
		);
	}
});
