import { describe, expect, it } from "vitest";

import { type LandingRole, landingRouteFor } from "./landing-route";

/**
 * Every role has to land somewhere it is allowed to be. Three call sites read
 * this table — the `/` redirect, invite redemption, and the role gate — so a
 * wrong answer here sends people in a circle or into a section that will bounce
 * them straight back out.
 */
describe("landingRouteFor", () => {
	it("sends a Super-Admin to the cross-tenant list", () => {
		expect(landingRouteFor("super_admin")).toBe("/admin");
	});

	it("sends every WP role to the shared WP dashboard", () => {
		for (const role of ["wp_admin", "wp_sub_admin", "wp_employee"] as const) {
			expect(landingRouteFor(role)).toBe("/wp");
		}
	});

	it("sends a certifier to their drafts, not to a fresh wizard", () => {
		expect(landingRouteFor("certifier")).toBe("/certifier/drafts");
	});

	it("answers for every role, and never with the root route", () => {
		const roles: LandingRole[] = [
			"super_admin",
			"wp_admin",
			"wp_sub_admin",
			"wp_employee",
			"certifier",
		];

		for (const role of roles) {
			const route = landingRouteFor(role);

			expect(route.startsWith("/")).toBe(true);
			// `/` is the redirect hub itself. Returning it would loop.
			expect(route).not.toBe("/");
		}
	});
});
