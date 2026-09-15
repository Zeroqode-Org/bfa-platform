import { createImpersonationToken } from "@bfa-platform/api/lib/impersonation-cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: a direct `/wp` request after a sign-in whose cookie cleanup failed
 * completely must not resume an old impersonation.
 *
 * The failure being guarded against: a Super-Admin impersonates, signs out, and
 * the sign-out clear fails; they sign in again, the sign-in clear fails, and the
 * local Supabase sign-out fails too. The browser now holds a *new* valid Supabase
 * session and the *old*, correctly signed impersonation cookie for the same
 * Super-Admin. The login form does not navigate — but typing `/wp` does.
 *
 * What stops it is server-side and does not depend on any of that cleanup: the
 * cookie is bound to the Supabase Auth `session_id` it was issued in, and the
 * route gate reads the request's `session_id` from an access token the Auth
 * server has just accepted.
 *
 * So this runs the real `/wp` layout and page, the real `requireAccount`, the
 * real `readVerifiedAuthSession`, the real cookie signing and the real
 * `resolveEffectiveCaller`. Only Next's request APIs, the Supabase Auth server
 * (a table of tokens it has issued) and the database (a two-profile stand-in)
 * are replaced.
 */

const SECRET = "web-session-binding-suite-secret-0123456789";
const IMPERSONATION_COOKIE = "bfa_impersonation";

const SUPER_ADMIN = "5a000000-0000-4000-8000-000000000001";
const WP_ADMIN = "a0000000-0000-4000-8000-000000000001";
const WP_ID = "0a000000-0000-4000-8000-00000000000a";
const FIRST_SESSION = "5e55a000-0000-4000-8000-00000000000a";
const LATER_SESSION = "5e55b000-0000-4000-8000-00000000000b";

// --- The browser --------------------------------------------------------------

const browser = {
	/** The Supabase session cookie's access token, as the server would read it. */
	accessToken: null as string | null,
	cookies: new Map<string, string>(),
};

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
			browser.cookies.has(name)
				? { name, value: browser.cookies.get(name) }
				: undefined,
	}),
}));

// --- The Supabase Auth server -------------------------------------------------

/** Access tokens the Auth server issued and still accepts, by token. */
const issuedTokens = new Map<string, { id: string; email: string }>();

function signIn(userId: string, sessionId: string) {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
		sub: userId,
		session_id: sessionId,
		role: "authenticated",
	})}.signed-by-auth-${sessionId}`;
	issuedTokens.set(token, { id: userId, email: "nathan@example.com" });
	browser.accessToken = token;
	return token;
}

vi.mock("@/lib/supabase/server", () => ({
	createClient: async () => ({
		auth: {
			getSession: async () => ({
				data: {
					session: browser.accessToken
						? { access_token: browser.accessToken }
						: null,
				},
				error: null,
			}),
			getUser: async (jwt?: string) => {
				const user = jwt ? issuedTokens.get(jwt) : undefined;
				return user
					? { data: { user }, error: null }
					: { data: { user: null }, error: new Error("invalid JWT") };
			},
		},
	}),
}));

// --- The database -------------------------------------------------------------

const profileRows: Record<string, Record<string, unknown>> = {
	[SUPER_ADMIN]: {
		id: SUPER_ADMIN,
		fullName: "Nathan Admin",
		globalRole: "super_admin",
		waterPurveyorId: null,
		waterPurveyorName: null,
		status: "active",
		certifierStatus: null,
		waterPurveyorStatus: null,
	},
	[WP_ADMIN]: {
		id: WP_ADMIN,
		fullName: "Riley Purveyor",
		globalRole: "wp_admin",
		waterPurveyorId: WP_ID,
		waterPurveyorName: "Riverside Water District",
		status: "active",
		certifierStatus: null,
		waterPurveyorStatus: "active",
	},
};

/** The first string bound into a Drizzle condition — the profile id here. */
function firstBoundString(node: unknown): string | undefined {
	if (!node || typeof node !== "object") return undefined;
	const value = (node as { value?: unknown }).value;
	if (typeof value === "string" && "encoder" in node) return value;
	for (const chunk of (node as { queryChunks?: unknown[] }).queryChunks ?? []) {
		const found = firstBoundString(chunk);
		if (found) return found;
	}
	return undefined;
}

vi.mock("@bfa-platform/db", () => ({
	db: {
		select: () => {
			let id: string | undefined;
			const builder = {
				from: () => builder,
				leftJoin: () => builder,
				innerJoin: () => builder,
				where: (condition: unknown) => {
					id = firstBoundString(condition);
					return builder;
				},
				limit: async () => {
					const row = id ? profileRows[id] : undefined;
					return row ? [row] : [];
				},
			};
			return builder;
		},
	},
}));

vi.mock("@bfa-platform/env/web", () => ({
	env: {
		NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
		NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder",
	},
}));

// --- The /wp route, with its visual parts stubbed -----------------------------

function WpShellStub() {
	return null;
}

vi.mock("@/components/shell/wp-shell", () => ({ WpShell: WpShellStub }));
vi.mock("@/components/wp/wp-dashboard", () => ({ WpDashboard: () => null }));
vi.mock("@bfa-platform/ui/components/page-title", () => ({
	PageTitle: () => null,
}));

const { default: WpLayout } = await import("./layout");
const { default: WpPage } = await import("./wp/page");

type ShellElement = {
	type: unknown;
	props: {
		account: {
			profileId: string;
			globalRole: string;
			waterPurveyorId: string | null;
			impersonation: unknown;
		};
	};
};

async function requestWp() {
	const element = (await WpLayout({ children: null })) as ShellElement;
	await WpPage();
	return element.props.account;
}

beforeEach(() => {
	vi.stubEnv("IMPERSONATION_COOKIE_SECRET", SECRET);
	browser.accessToken = null;
	browser.cookies.clear();
	issuedTokens.clear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/** What `startImpersonation` sets during the first session. */
function impersonateInFirstSession() {
	signIn(SUPER_ADMIN, FIRST_SESSION);
	const { token } = createImpersonationToken(
		{
			actorProfileId: SUPER_ADMIN,
			targetProfileId: WP_ADMIN,
			waterPurveyorId: WP_ID,
			authSessionId: FIRST_SESSION,
		},
		SECRET,
	);
	browser.cookies.set(IMPERSONATION_COOKIE, token);
	return token;
}

describe("impersonation cookie bound to the auth session", () => {
	it("control: in the session that started it, /wp renders as the impersonated admin with the banner", async () => {
		impersonateInFirstSession();

		await expect(requestWp()).resolves.toMatchObject({
			profileId: WP_ADMIN,
			globalRole: "wp_admin",
			waterPurveyorId: WP_ID,
			impersonation: { waterPurveyorName: "Riverside Water District" },
		});
	});

	it("a direct /wp request after a new sign-in whose cleanups all failed does not resume the impersonation", async () => {
		const oldCookie = impersonateInFirstSession();

		// Sign-out clear failed, sign-in clear failed, local sign-out failed: the
		// browser keeps the old cookie *and* a fresh, valid session for the same
		// Super-Admin.
		signIn(SUPER_ADMIN, LATER_SESSION);
		expect(browser.cookies.get(IMPERSONATION_COOKIE)).toBe(oldCookie);

		await expect(requestWp()).resolves.toMatchObject({
			profileId: SUPER_ADMIN,
			globalRole: "super_admin",
			waterPurveyorId: null,
			impersonation: null,
		});
	});

	it("takes the session id only from a token the Auth server accepted", async () => {
		impersonateInFirstSession();

		// A hand-made token claiming the first session, never issued by Auth.
		const encode = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		browser.accessToken = `${encode({ alg: "HS256" })}.${encode({
			sub: SUPER_ADMIN,
			session_id: FIRST_SESSION,
		})}.forged`;
		issuedTokens.clear();

		const outcome = await requestWp().then(
			() => "rendered",
			(error: unknown) =>
				error instanceof Redirected ? error.url : Promise.reject(error),
		);
		expect(outcome).toBe("/login");
	});
});
