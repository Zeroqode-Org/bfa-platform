import { CallerRefusedError } from "@bfa-platform/api/caller-refusal";
import type { Caller } from "@bfa-platform/api/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the route gates do with a session Supabase accepted and the profile gate
 * refused.
 *
 * This is the glue the sign-in screen depends on: `resolveCaller` decides *why*
 * a session is unusable, and `requireAccount` is the only thing that turns that
 * into somewhere for the browser to go. Getting it wrong is invisible in
 * isolation — both halves work, and the person just lands on a blank form.
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

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
	createClient: async () => ({ auth: { getUser } }),
}));

const resolveCaller = vi.fn();

// Replaced whole rather than spread over the original: `context.ts` builds the
// Drizzle connection at import time, and a unit run has no database to give it.
// The refusal vocabulary it re-exports lives in its own module, which is why
// `CallerRefusedError` above is the real one.
vi.mock("@bfa-platform/api/context", () => ({
	resolveCaller: (...args: unknown[]) => resolveCaller(...args),
}));

const { requireAccount } = await import("./auth");

const caller: Caller = {
	profileId: "3d5f4a12-9b8c-4d0e-a1f2-3b4c5d6e7f80",
	fullName: "Ada Tester",
	globalRole: "certifier",
	waterPurveyorId: null,
	waterPurveyorName: null,
};

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
	resolveCaller.mockReset();
	getUser.mockResolvedValue({
		data: { user: { id: caller.profileId, email: "ada@example.com" } },
	});
});

describe("requireAccount", () => {
	it("returns the caller plus their sign-in email when the profile resolves", async () => {
		resolveCaller.mockResolvedValue(caller);

		await expect(requireAccount()).resolves.toEqual({
			...caller,
			email: "ada@example.com",
		});
	});

	it("names the reason when a blocked account reaches a gate", async () => {
		// The bug this exists to prevent: a blocked certifier signs in
		// successfully — blocking writes `certifiers.status`, not anything in
		// `auth.users` — and used to be bounced to a bare `/login`, which looks
		// exactly like a mistyped password.
		resolveCaller.mockRejectedValue(
			new CallerRefusedError("blocked", "Account blocked"),
		);

		expect(await redirectFrom(requireAccount)).toBe("/login?notice=blocked");
	});

	it("distinguishes an unfinished account from a blocked one", async () => {
		// Different problem, different advice: a new invitation link rather than a
		// conversation with a water purveyor.
		resolveCaller.mockRejectedValue(
			new CallerRefusedError("no_profile", "No profile for this account"),
		);

		expect(await redirectFrom(requireAccount)).toBe("/login?notice=no_profile");
	});

	it("still says something when the refusal is not one it recognises", async () => {
		// Silence is the state this whole change exists to end, so an unexpected
		// failure gets the vaguer notice rather than none at all.
		resolveCaller.mockRejectedValue(new Error("connection reset"));

		expect(await redirectFrom(requireAccount)).toBe("/login?notice=no_profile");
	});

	it("sends an anonymous visitor to a plain sign-in form", async () => {
		// Nothing has gone wrong for them — there is no notice to show.
		getUser.mockResolvedValue({ data: { user: null } });

		expect(await redirectFrom(requireAccount)).toBe("/login");
	});
});
