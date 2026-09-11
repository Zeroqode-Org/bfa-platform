import { describe, expect, it } from "vitest";

import {
	SIGN_IN_NOTICE_PARAM,
	signInNoticeFor,
	signInNoticeRedirectFor,
	signInNoticeRoute,
} from "./sign-in-notice";

/**
 * The sign-in screen's explanation for a session that resolved to a refusal.
 *
 * The behaviour worth pinning down is what the copy must *not* do — a blocked
 * certifier is blocked by one of several water purveyors, and the screen has to
 * explain the situation without naming which.
 */

describe("signInNoticeRoute", () => {
	it("sends a refusal to the sign-in screen as a query value", () => {
		expect(signInNoticeRoute("blocked")).toBe("/login?notice=blocked");
		expect(signInNoticeRoute("no_profile")).toBe("/login?notice=no_profile");
	});

	it("builds the route from the shared parameter name", () => {
		// The gate writes it and the page reads it; one constant means they cannot
		// drift into two spellings.
		expect(signInNoticeRoute("blocked")).toContain(`${SIGN_IN_NOTICE_PARAM}=`);
	});
});

describe("signInNoticeFor", () => {
	it("explains a blocked account", () => {
		const notice = signInNoticeFor("blocked");

		expect(notice?.tone).toBe("danger");
		expect(notice?.title).toMatch(/blocked/i);
		// The whole point: say the password was fine, so nobody retypes it.
		expect(notice?.description).toMatch(/password is correct/i);
		// And say what to do next.
		expect(notice?.description).toMatch(/contact/i);
	});

	it("does not say who blocked them, or which switch was thrown", () => {
		// A certifier can be authorized by several purveyors and blocked by any of
		// them. Naming the one that did it would tell them something about a tenant
		// that is not theirs to know — and `profiles.status` blocks come from the
		// platform administrator instead, so the copy has to cover both without
		// disclosing either.
		const description = signInNoticeFor("blocked")?.description ?? "";

		expect(description).not.toMatch(/certifiers?\.status|profiles?\.status/i);
		expect(description).not.toMatch(/blocked by/i);
		// It still points somewhere useful rather than nowhere.
		expect(description).toMatch(/water purveyor|administrator/i);
	});

	it("tells an unfinished account to ask for a new invitation instead", () => {
		// A different problem needing a different action — a new link, not a
		// conversation — so it must not read as a block.
		const notice = signInNoticeFor("no_profile");

		expect(notice?.tone).toBe("warning");
		expect(notice?.description).toMatch(/new invitation link/i);
		expect(notice?.title).not.toMatch(/blocked/i);
	});

	it("takes the first value when the parameter is repeated", () => {
		expect(signInNoticeFor(["blocked", "no_profile"])?.tone).toBe("danger");
	});

	it("renders nothing for an absent, empty or unrecognised value", () => {
		// A hand-typed `?notice=whatever` must produce no banner rather than an
		// empty one — and nothing from the URL is ever displayed, so the value can
		// only ever select between fixed copy.
		for (const value of [
			undefined,
			"",
			"whatever",
			"BLOCKED",
			"__proto__",
			"toString",
		]) {
			expect(signInNoticeFor(value)).toBeNull();
		}

		expect(signInNoticeFor([])).toBeNull();
	});
});

describe("signInNoticeRedirectFor", () => {
	/** A refused call as it reaches the browser, once tRPC has serialised it. */
	function wireError(data: unknown) {
		return { message: "Account blocked", data };
	}

	it("sends a refused request to the sign-in screen with the reason", () => {
		// The other half of the gates: a certifier already sitting on a screen
		// when a purveyor blocks them. Their next query comes back refused, and
		// without this they get a toast on a page that still looks signed in.
		expect(
			signInNoticeRedirectFor(
				wireError({ code: "FORBIDDEN", refusal: "blocked" }),
			),
		).toBe("/login?notice=blocked");

		expect(
			signInNoticeRedirectFor(
				wireError({ code: "FORBIDDEN", refusal: "no_profile" }),
			),
		).toBe("/login?notice=no_profile");
	});

	it("leaves an ordinary permission error where it is", () => {
		// This is the case that must not regress. Every role check in the API
		// raises FORBIDDEN too — a WP Employee pressing Block, a certifier
		// reaching a WP list — and throwing those callers out to a sign-in screen
		// would be worse than the toast they get now. Only `refusal` decides.
		expect(
			signInNoticeRedirectFor(
				wireError({ code: "FORBIDDEN", httpStatus: 403 }),
			),
		).toBeNull();
	});

	it("ignores anything that is not a refusal it knows", () => {
		for (const error of [
			wireError({ refusal: "whatever" }),
			wireError({ refusal: "__proto__" }),
			wireError({ refusal: 42 }),
			wireError({ refusal: null }),
			wireError(null),
			wireError(undefined),
			new Error("connection reset"),
			null,
			undefined,
			"blocked",
		]) {
			expect(signInNoticeRedirectFor(error)).toBeNull();
		}
	});

	it("agrees with the route the server gate would have used", () => {
		// Two paths, one destination — a refused query and a refused page load
		// must not land on different screens.
		expect(signInNoticeRedirectFor(wireError({ refusal: "blocked" }))).toBe(
			signInNoticeRoute("blocked"),
		);
	});
});
