import type { Caller } from "@bfa-platform/api/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The certifier area is certifiers only — and above all, an impersonated WP
 * admin never lands inside it.
 *
 * `CertifierShell` has no impersonation banner. Before this gate, the certifier
 * layout and pages called `requireAccount()` alone, so a Super-Admin
 * impersonating a water purveyor could open `/certifier/drafts` directly and be
 * shown an authenticated shell with no warning and no Exit control. The gate
 * now sends every non-certifier to its own landing route, which for any WP
 * identity is `/wp`, where `DashboardShell` always draws the banner.
 *
 * These run the real layout, the real pages and the real `requireGlobalRole`;
 * only Next's request APIs, the Supabase clients (server and browser) and the
 * shared caller resolver are replaced, as in `lib/auth.test.ts`.
 */

vi.mock("server-only", () => ({}));

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

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) =>
			name === "bfa_impersonation"
				? { name, value: "v1.payload.signature" }
				: undefined,
	}),
}));

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
	createClient: async () => ({ auth: { getUser } }),
}));

// The profile page imports `ProfileForm`, which imports the browser client —
// and loading the real one validates the public Supabase variables at import
// time, so an offline `npm test` could not even collect this file. The gate
// never renders the form, so this is never called; it only keeps the import
// from reaching env validation, the same stub the sibling web suites use.
vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({ auth: { updateUser: vi.fn() } }),
}));

const SESSION_ID = "5e55a000-0000-4000-8000-00000000000a";

// Session verification is tested on its own; this gate only needs a user and
// the auth session they are in.
vi.mock("@bfa-platform/api/lib/auth-session", () => ({
	readVerifiedAuthSession: async (client: {
		auth: { getUser: () => Promise<{ data: { user: unknown } }> };
	}) => {
		const {
			data: { user },
		} = await client.auth.getUser();
		return { user, sessionId: user ? SESSION_ID : null };
	},
}));

const resolveEffectiveCaller = vi.fn();

vi.mock("@bfa-platform/api/context", () => ({
	resolveEffectiveCaller: (...args: unknown[]) =>
		resolveEffectiveCaller(...args),
}));

// Stand-ins so the layout's and pages' return values can be inspected without
// rendering a shell or a page body.
function CertifierShellStub() {
	return null;
}
function PlaceholderPageStub() {
	return null;
}

vi.mock("@/components/shell/certifier-shell", () => ({
	CertifierShell: CertifierShellStub,
}));
vi.mock("@/components/placeholder-page", () => ({
	PlaceholderPage: PlaceholderPageStub,
}));

const { default: CertifierLayout } = await import("./layout");
const pages = {
	"/certifier/drafts": (await import("./certifier/drafts/page")).default,
	"/certifier/profile": (await import("./certifier/profile/page")).default,
	"/certifier/submitted": (await import("./certifier/submitted/page")).default,
	"/certifier/wizard": (await import("./certifier/wizard/page")).default,
};

const certifier: Caller = {
	profileId: "3d5f4a12-9b8c-4d0e-a1f2-3b4c5d6e7f80",
	fullName: "Ada Tester",
	globalRole: "certifier",
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

const superAdmin: Caller = {
	profileId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
	fullName: "Nathan Admin",
	globalRole: "super_admin",
	waterPurveyorId: null,
	waterPurveyorName: null,
};

function actingAsSelf(account: Caller) {
	return {
		caller: account,
		actor: account,
		impersonation: null,
		rejection: null,
	};
}

const impersonatingWpAdmin = {
	caller: wpAdmin,
	actor: superAdmin,
	impersonation: {
		targetProfileId: wpAdmin.profileId,
		waterPurveyorId: wpAdmin.waterPurveyorId,
		expiresAt: new Date(Date.now() + 60_000),
	},
	rejection: null,
};

/** Where a server component sent the browser, or null if it rendered. */
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
	getUser.mockResolvedValue({
		data: { user: { id: "session-user", email: "someone@example.com" } },
	});
});

describe("certifier area gate", () => {
	it("lets a certifier into the certifier shell and every certifier page", async () => {
		resolveEffectiveCaller.mockResolvedValue(actingAsSelf(certifier));

		const element = (await CertifierLayout({ children: null })) as {
			type: unknown;
			props: { account: { globalRole: string; impersonation: unknown } };
		};

		expect(element.type).toBe(CertifierShellStub);
		expect(element.props.account).toMatchObject({
			globalRole: "certifier",
			impersonation: null,
		});

		for (const [route, Page] of Object.entries(pages)) {
			expect(
				await redirectFrom(() => Page({ searchParams: Promise.resolve({}) })),
				route,
			).toBeNull();
		}
	});

	it("sends a WP identity to /wp from the layout and from every page", async () => {
		resolveEffectiveCaller.mockResolvedValue(actingAsSelf(wpAdmin));

		expect(await redirectFrom(() => CertifierLayout({ children: null }))).toBe(
			"/wp",
		);
		for (const [route, Page] of Object.entries(pages)) {
			expect(
				await redirectFrom(() => Page({ searchParams: Promise.resolve({}) })),
				route,
			).toBe("/wp");
		}
	});

	it.each(["wp_sub_admin", "wp_employee"] as const)(
		"sends a %s to /wp as well",
		async (globalRole) => {
			resolveEffectiveCaller.mockResolvedValue(
				actingAsSelf({ ...wpAdmin, globalRole }),
			);

			expect(
				await redirectFrom(() => CertifierLayout({ children: null })),
			).toBe("/wp");
		},
	);

	it("sends an impersonated WP admin to /wp, so the unbannered certifier shell is unreachable", async () => {
		resolveEffectiveCaller.mockResolvedValue(impersonatingWpAdmin);

		expect(await redirectFrom(() => CertifierLayout({ children: null }))).toBe(
			"/wp",
		);
		for (const [route, Page] of Object.entries(pages)) {
			expect(
				await redirectFrom(() => Page({ searchParams: Promise.resolve({}) })),
				route,
			).toBe("/wp");
		}
		// The gate read the impersonation cookie through the shared helper — the
		// redirect is decided by the effective role, not the Super-Admin's own.
		expect(resolveEffectiveCaller).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"v1.payload.signature",
			SESSION_ID,
		);
	});

	it("sends a Super-Admin who is not impersonating to /admin", async () => {
		resolveEffectiveCaller.mockResolvedValue(actingAsSelf(superAdmin));

		expect(await redirectFrom(() => pages["/certifier/drafts"]())).toBe(
			"/admin",
		);
	});

	it("still sends an anonymous visitor to sign in", async () => {
		getUser.mockResolvedValue({ data: { user: null } });

		expect(await redirectFrom(() => CertifierLayout({ children: null }))).toBe(
			"/login",
		);
	});
});
