import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Every page behind a sign-in resolves the caller for itself.
 *
 * This is a structural test, and it exists because the obvious place to put the
 * gate is the wrong one. A route group's `layout.tsx` runs on a full load and
 * is then reused: a client-side navigation re-renders only the changed page on
 * the server, so the layout's gate never runs again. Verified against a running
 * dev server, not inferred — with a probe layout and two probe pages, a
 * `<Link>` navigation logged the page and not the layout. `template.tsx`
 * behaves the same way.
 *
 * That matters because a session can stop being usable while it is open:
 * `certifiers.status` is written by a water purveyor from `/wp/certifiers`, and
 * nothing in `auth.users` changes. A blocked certifier clicking from Drafts to
 * Profile would otherwise be shown the page.
 *
 * Asserted over the file tree rather than over the pages that exist today,
 * because the failure mode is a *new* page added without the gate — which is
 * silent, and which no test of current behaviour would catch.
 */

const APP = fileURLToPath(new URL(".", import.meta.url));

/** The signed-in route groups, and the gate each one's pages must call. */
const PROTECTED_GROUPS = {
	"(certifier)": "requireAccount",
	"(wp)": "requireAccount",
	"(admin)": "requireGlobalRole",
} as const;

/**
 * Every `page.tsx` under a group, walked by hand rather than globbed — the repo
 * has no glob dependency of its own, and this needs no more than a directory
 * listing.
 */
function pagesIn(group: string): string[] {
	const found: string[] = [];

	function walk(relative: string) {
		for (const entry of readdirSync(join(APP, relative), {
			withFileTypes: true,
		})) {
			const next = `${relative}/${entry.name}`;

			if (entry.isDirectory()) walk(next);
			else if (entry.name === "page.tsx") found.push(next);
		}
	}

	walk(group);

	return found.sort();
}

describe("protected pages", () => {
	for (const [group, gate] of Object.entries(PROTECTED_GROUPS)) {
		describe(group, () => {
			const pages = pagesIn(group);

			it("has pages to check", () => {
				// A glob that silently matched nothing would make every assertion
				// below vacuously true.
				expect(pages.length).toBeGreaterThan(0);
			});

			for (const page of pages) {
				it(`${page} resolves the caller itself`, () => {
					const source = readFileSync(`${APP}${page}`, "utf8");

					expect(source).toContain(`from "@/lib/auth"`);
					expect(source).toContain(`${gate}(`);
					// Awaited, not called and dropped: the redirect it throws has to
					// unwind the render.
					expect(source).toMatch(new RegExp(`await\\s+${gate}\\(`));
				});
			}
		});

		it(`${group} gates its layout too, for full loads and refreshes`, () => {
			// The layout is not redundant — it is the only gate that runs before the
			// shell is drawn, so a blocked person never sees a sidebar at all.
			const layout = readFileSync(`${APP}${group}/layout.tsx`, "utf8");

			expect(layout).toMatch(
				/await\s+(requireAccount|requireGlobalRole|requireCaller)\(/,
			);
		});
	}
});
