import { CallerRefusedError } from "@bfa-platform/api/caller-refusal";
import type { Caller } from "@bfa-platform/api/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the route gates do with a session Supabase accepted and the profile gate
 * refused, and with a Super-Admin who is impersonating.
 *
 * This is the glue the sign-in screen depends on: `resolveEffectiveCaller`
 * decides *who* a session runs as and *why* it may be unusable, and
 * `requireAccount` is the only thing that turns that into somewhere for the
 * browser to go. Getting it wrong is invisible in isolation — both halves work,
 * and the person just lands on a blank form.
 */

// `auth.ts` is server-only; the marker package throws when it is imported
// outside a server bundle, and it carries no behaviour worth keeping here.
vi.mock("server-only", () => ({}));

/** Stands in for Next's `redirect`, which never returns and throws to unwind. */
class Redirected extends Error {
	constructor(readonly url: string) {
		super(`redirect: ${url}`);
	}
}

vi.mock("next/navigation", () => ({
	redirect: (url: string) => {
		throw new Redirected(url);
	},
}));

const cookieValues = new Map<string, string>();

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) =>
			cookieValues.has(name)
				? { name, value: cookieValues.get(name) }
				: undefined,
	}),
}));

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
	createClient: async () => ({ auth: { getUser } }),
}));

const resolveEffectiveCaller = vi.fn();

// Replaced whole rather than spread over the original: `context.ts` builds the
// Drizzle connection at import time, and a unit run has no database to give it.
// The refusal vocabulary it re-exports lives in its own module, which is why
// `CallerRefusedError` above is the real one.
vi.mock("@bfa-platform/api/context", () => ({
	resolveEffectiveCaller: (...args: unknown[]) =>
		resolveEffectiveCaller(...args),
}));

const { requireAccount, requireGlobalRole } = await import("./auth");

const caller: Caller = {
	profileId: "3d5f4a12-9b8c-4d0e-a1f2-3b4c5d6e7f80",
	fullName: "Ada Tester",
	globalRole: "certifier",
	waterPurveyorId: null,
	waterPurveyorName: null,
};

const superAdmin: Caller = {
	profileId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
	fullName: "Nathan Admin",
	globalRole: "super_admin",
	waterPurveyorId: null,
	waterPurveyorName: null,
};

const wpAdmin: Caller = {
	profileId: "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b",
	fullName: "Riley Purveyor",
	globalRole: "wp_admin",
	waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
	waterPurveyorName: "Riverside Water District",
};

function actingAsSelf(account: Caller) {
	return {
		caller: account,
		actor: account,
		impersonation: null,
		rejection: null,
	};
}

/** Where `requireAccount` sent the browser, or `null` if it returned normally. */
async function redirectFrom(run: () => Promise<unknown>) {
	try {
		await run();
		return null;
	} catch (error) {
		if (error instanceof Redirected) return error.url;
		throw error;
	}
}

beforeEach(() => {
	getUser.mockReset();
	resolveEffectiveCaller.mockReset();
	cookieValues.clear();
	getUser.mockResolvedValue({
		data: { user: { id: caller.profileId, email: "ada@example.com" } },
	});
});

describe("requireAccount", () => {
	it("returns the caller plus their sign-in email when the profile resolves", async () => {
		resolveEffectiveCaller.mockResolvedValue(actingAsSelf(caller));

		await expect(requireAccount()).resolves.toEqual({
			...caller,
			email: "ada@example.com",
			impersonation: null,
		});
	});

	it("names the reason when a blocked account reaches a gate", async () => {
		// The bug this exists to prevent: a blocked certifier signs in
		// successfully — blocking writes `certifiers.status`, not anything in
		// `auth.users` — and used to be bounced to a bare `/login`, which looks
		// exactly like a mistyped password.
		resolveEffectiveCaller.mockRejectedValue(
			new CallerRefusedError("blocked", "Account blocked"),
		);

		expect(await redirectFrom(requireAccount)).toBe("/login?notice=blocked");
	});

	it("distinguishes an unfinished account from a blocked one", async () => {
		// Different problem, different advice: a new invitation link rather than a
		// conversation with a water purveyor.
		resolveEffectiveCaller.mockRejectedValue(
			new CallerRefusedError("no_profile", "No profile for this account"),
		);

		expect(await redirectFrom(requireAccount)).toBe("/login?notice=no_profile");
	});

	it("still says something when the refusal is not one it recognises", async () => {
		// Silence is the state this whole change exists to end, so an unexpected
		// failure gets the vaguer notice rather than none at all.
		resolveEffectiveCaller.mockRejectedValue(new Error("connection reset"));

		expect(await redirectFrom(requireAccount)).toBe("/login?notice=no_profile");
	});

	it("sends an anonymous visitor to a plain sign-in form", async () => {
		// Nothing has gone wrong for them — there is no notice to show.
		getUser.mockResolvedValue({ data: { user: null } });

		expect(await redirectFrom(requireAccount)).toBe("/login");
		expect(resolveEffectiveCaller).not.toHaveBeenCalled();
	});
});

describe("requireAccount while impersonating", () => {
	beforeEach(() => {
		getUser.mockResolvedValue({
			data: { user: { id: superAdmin.profileId, email: "nathan@example.com" } },
		});
	});

	it("hands the raw impersonation cookie to the shared helper, and nothing else decides", async () => {
		cookieValues.set("bfa_impersonation", "v1.payload.signature");
		resolveEffectiveCaller.mockResolvedValue(actingAsSelf(superAdmin));

		await requireAccount();

		expect(resolveEffectiveCaller).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: superAdmin.profileId }),
			"v1.payload.signature",
		);
	});

	it("returns the impersonated admin as the account, with the banner state", async () => {
		resolveEffectiveCaller.mockResolvedValue({
			caller: wpAdmin,
			actor: superAdmin,
			impersonation: {
				targetProfileId: wpAdmin.profileId,
				waterPurveyorId: wpAdmin.waterPurveyorId,
				expiresAt: new Date(),
			},
			rejection: null,
		});

		await expect(requireAccount()).resolves.toEqual({
			...wpAdmin,
			// The Super-Admin's own address is never shown under the admin's name.
			email: null,
			impersonation: { waterPurveyorName: "Riverside Water District" },
		});
	});

	it("treats an ignored cookie as no impersonation at all", async () => {
		cookieValues.set("bfa_impersonation", "tampered");
		resolveEffectiveCaller.mockResolvedValue({
			...actingAsSelf(superAdmin),
			rejection: "bad_signature",
		});

		await expect(requireAccount()).resolves.toMatchObject({
			globalRole: "super_admin",
			email: "nathan@example.com",
			impersonation: null,
		});
	});

	it("sends an impersonating Super-Admin out of /admin to the purveyor's dashboard", async () => {
		// The role gate reads the effective role, so /admin is closed until they
		// exit — there is no half-impersonated Super-Admin screen.
		resolveEffectiveCaller.mockResolvedValue({
			caller: wpAdmin,
			actor: superAdmin,
			impersonation: {
				targetProfileId: wpAdmin.profileId,
				waterPurveyorId: wpAdmin.waterPurveyorId,
				expiresAt: new Date(),
			},
			rejection: null,
		});

		expect(await redirectFrom(() => requireGlobalRole(["super_admin"]))).toBe(
			"/wp",
		);
	});
});
