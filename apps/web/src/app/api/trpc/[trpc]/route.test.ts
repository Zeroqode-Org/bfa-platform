import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CSRF protection on the tRPC route: a POST whose `Origin` is not this app's
 * own is refused before tRPC does anything at all.
 *
 * These drive the real route handler, the real `fetchRequestHandler` and the
 * real `appRouter` — every procedure, middleware and role check. Only the
 * context module is replaced, with spies, because what has to be proved is what
 * does *not* happen on a forged request: no context is created (so no Supabase
 * session is read or refreshed), no caller or impersonation is resolved, and no
 * procedure runs. The database is a tripwire that fails any test reaching it.
 */

const APP_ORIGIN = "https://bfa.example.com";
const SUPER_ADMIN = "5a000000-0000-4000-8000-000000000001";
const WP_ID = "0a000000-0000-4000-8000-00000000000a";

const superAdmin = {
	profileId: SUPER_ADMIN,
	fullName: "Nathan Admin",
	globalRole: "super_admin" as const,
	waterPurveyorId: null,
	waterPurveyorName: null,
};

const createContext = vi.fn();
const resolveEffectiveCaller = vi.fn();
const findImpersonationTarget = vi.fn();

vi.mock("@bfa-platform/api/context", () => ({
	createContext: (...args: unknown[]) => createContext(...args),
	resolveEffectiveCaller: (...args: unknown[]) =>
		resolveEffectiveCaller(...args),
	findImpersonationTarget: (...args: unknown[]) =>
		findImpersonationTarget(...args),
	loadImpersonationTarget: vi.fn(),
	resolveCaller: vi.fn(),
}));

vi.mock("@bfa-platform/db", () => ({
	db: new Proxy(
		{},
		{
			get() {
				throw new Error("the database must not be reached in this suite");
			},
		},
	),
}));

vi.mock("@bfa-platform/env/web", () => ({
	env: {
		NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
		NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder",
	},
}));

vi.mock("@bfa-platform/env/server", () => ({
	env: { NODE_ENV: "test", EMAIL_DRIVER: "console" },
}));

const { GET, POST } = await import("./route");

type RouteRequest = Parameters<typeof POST>[0];

const SESSION_COOKIE = "sb-project-auth-token=secret-session-value";
const IMPERSONATION_COOKIE =
	"bfa_impersonation=v2.secret-claims.secret-signature";

function post(
	path: string,
	{ origin, body = {} }: { origin?: string | null; body?: unknown } = {},
) {
	const headers = new Headers({
		"content-type": "application/json",
		cookie: `${SESSION_COOKIE}; ${IMPERSONATION_COOKIE}`,
	});
	if (origin !== undefined && origin !== null) headers.set("origin", origin);

	return new Request(`${APP_ORIGIN}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	}) as unknown as RouteRequest;
}

function get(path: string, origin?: string) {
	const headers = new Headers({ cookie: SESSION_COOKIE });
	if (origin) headers.set("origin", origin);
	return new Request(`${APP_ORIGIN}${path}`, {
		method: "GET",
		headers,
	}) as unknown as RouteRequest;
}

let logLines: string[];

function csrfLogs() {
	return logLines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.event === "csrf_request_rejected");
}

function expectNothingBehindTheGuardRan() {
	expect(createContext).not.toHaveBeenCalled();
	expect(resolveEffectiveCaller).not.toHaveBeenCalled();
	expect(findImpersonationTarget).not.toHaveBeenCalled();
}

beforeEach(() => {
	createContext.mockReset();
	resolveEffectiveCaller.mockReset();
	findImpersonationTarget.mockReset();

	createContext.mockImplementation(
		async ({ resHeaders }: { resHeaders: Headers }) => ({
			supabase: {},
			user: { id: SUPER_ADMIN },
			authSessionId: "5e55a000-0000-4000-8000-00000000000a",
			resHeaders,
			impersonationToken: null,
		}),
	);
	resolveEffectiveCaller.mockResolvedValue({
		caller: superAdmin,
		actor: superAdmin,
		impersonation: null,
		rejection: null,
	});

	logLines = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		logLines.push(String(value));
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("tRPC POST from this app's own origin", () => {
	it("reaches the normal tRPC handler", async () => {
		const response = await POST(
			post("/api/trpc/session.clearImpersonation", {
				origin: APP_ORIGIN,
				body: { reason: "sign_out" },
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			result: { data: { cleared: false } },
		});
		expect(createContext).toHaveBeenCalledTimes(1);
		expect(response.headers.get("set-cookie")).toMatch(/^bfa_impersonation=;/);
		expect(csrfLogs()).toEqual([]);
	});

	it("still accepts an httpBatchLink batch", async () => {
		const response = await POST(
			post(
				"/api/trpc/session.clearImpersonation,session.clearImpersonation?batch=1",
				{
					origin: APP_ORIGIN,
					body: { 0: { reason: "sign_out" }, 1: { reason: "sign_in" } },
				},
			),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([
			{ result: { data: { cleared: false } } },
			{ result: { data: { cleared: false } } },
		]);
	});

	it("runs a protected mutation as far as its own checks", async () => {
		// Control for the forged request below: the same call from the app's own
		// origin reaches caller resolution and the procedure body.
		vi.stubEnv(
			"IMPERSONATION_COOKIE_SECRET",
			"route-suite-impersonation-secret-0123456789",
		);
		findImpersonationTarget.mockResolvedValue({
			ok: false,
			reason: "wp_not_found",
		});

		const response = await POST(
			post("/api/trpc/superAdmin.startImpersonation", {
				origin: APP_ORIGIN,
				body: { waterPurveyorId: WP_ID },
			}),
		);

		expect(response.status).toBe(404);
		expect(createContext).toHaveBeenCalledTimes(1);
		expect(resolveEffectiveCaller).toHaveBeenCalledTimes(1);
		expect(findImpersonationTarget).toHaveBeenCalledWith(WP_ID);
	});
});

describe("tRPC POST refused before tRPC runs", () => {
	it("refuses a cross-origin POST with a generic 403", async () => {
		const response = await POST(
			post("/api/trpc/session.clearImpersonation", {
				origin: "https://evil.example.net",
				body: { reason: "sign_out" },
			}),
		);

		expect(response.status).toBe(403);
		await expect(response.text()).resolves.toBe("Forbidden");
		expect(response.headers.get("set-cookie")).toBeNull();
		expectNothingBehindTheGuardRan();
		expect(csrfLogs()).toEqual([
			expect.objectContaining({
				reason: "cross_origin",
				method: "POST",
				path: "/api/trpc/session.clearImpersonation",
			}),
		]);
	});

	it("refuses a POST with no Origin", async () => {
		const response = await POST(
			post("/api/trpc/session.clearImpersonation", {
				body: { reason: "sign_out" },
			}),
		);

		expect(response.status).toBe(403);
		expectNothingBehindTheGuardRan();
		expect(csrfLogs()[0]).toMatchObject({ reason: "missing_origin" });
	});

	it.each([
		["an empty Origin", "", "missing_origin"],
		["an opaque null Origin", "null", "malformed_origin"],
		["a value that is not a URL", "not a url", "malformed_origin"],
		["an Origin with a trailing slash", `${APP_ORIGIN}/`, "malformed_origin"],
		["an Origin with a path", `${APP_ORIGIN}/api/trpc`, "malformed_origin"],
		[
			"an Origin with credentials",
			"https://user@bfa.example.com",
			"malformed_origin",
		],
		["a non-http scheme", "ftp://bfa.example.com", "malformed_origin"],
		["the same host over http", "http://bfa.example.com", "cross_origin"],
		["the same host on another port", `${APP_ORIGIN}:8443`, "cross_origin"],
		["a subdomain", "https://evil.bfa.example.com", "cross_origin"],
		[
			"a lookalike that starts with the app's origin",
			"https://bfa.example.com.evil.net",
			"cross_origin",
		],
	])("refuses %s", async (_label, origin, reason) => {
		const response = await POST(
			post("/api/trpc/session.clearImpersonation", {
				origin,
				body: { reason: "sign_out" },
			}),
		);

		expect(response.status).toBe(403);
		expectNothingBehindTheGuardRan();
		expect(csrfLogs()[0]).toMatchObject({ reason });
	});

	it("cannot reach superAdmin.startImpersonation or any protected mutation cross-origin", async () => {
		vi.stubEnv(
			"IMPERSONATION_COOKIE_SECRET",
			"route-suite-impersonation-secret-0123456789",
		);

		for (const [path, body] of [
			["/api/trpc/superAdmin.startImpersonation", { waterPurveyorId: WP_ID }],
			["/api/trpc/superAdmin.endImpersonation", {}],
			[
				"/api/trpc/superAdmin.setWaterPurveyorStatus",
				{ waterPurveyorId: WP_ID, status: "blocked" },
			],
			[
				"/api/trpc/repairCompanies.createRepairCompany",
				{ companyName: "Forged Repairs" },
			],
			[
				"/api/trpc/superAdmin.startImpersonation,repairCompanies.createRepairCompany?batch=1",
				{ 0: { waterPurveyorId: WP_ID }, 1: { companyName: "Forged Repairs" } },
			],
		] as const) {
			const response = await POST(
				post(path, { origin: "https://evil.example.net", body }),
			);

			expect(response.status, path).toBe(403);
			await expect(response.text()).resolves.toBe("Forbidden");
			expect(response.headers.get("set-cookie"), path).toBeNull();
		}

		expectNothingBehindTheGuardRan();
	});

	it("logs the refusal without cookies, tokens, the Origin value or the body", async () => {
		await POST(
			post("/api/trpc/superAdmin.startImpersonation", {
				origin: "https://evil.example.net",
				body: { waterPurveyorId: WP_ID },
			}),
		);

		expect(logLines).toHaveLength(1);
		const [line] = logLines;
		expect(Object.keys(JSON.parse(line as string)).sort()).toEqual([
			"event",
			"method",
			"path",
			"reason",
			"timestamp",
		]);
		for (const sensitive of [
			"secret-session-value",
			"secret-claims",
			"secret-signature",
			"evil.example.net",
			WP_ID,
		]) {
			expect(line).not.toContain(sensitive);
		}
	});
});

describe("tRPC GET", () => {
	it("is unaffected: a query with no Origin runs normally", async () => {
		const response = await GET(get("/api/trpc/whoami"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			result: {
				data: {
					profileId: SUPER_ADMIN,
					globalRole: "super_admin",
					waterPurveyorId: null,
					impersonating: false,
				},
			},
		});
		expect(createContext).toHaveBeenCalledTimes(1);
		expect(csrfLogs()).toEqual([]);
	});

	it("is unaffected by an Origin header either way", async () => {
		const response = await GET(
			get("/api/trpc/whoami", "https://evil.example.net"),
		);

		expect(response.status).toBe(200);
		expect(csrfLogs()).toEqual([]);
	});

	it("still cannot run a mutation, which tRPC refuses over GET", async () => {
		const response = await GET(
			get(
				`/api/trpc/superAdmin.startImpersonation?input=${encodeURIComponent(
					JSON.stringify({ waterPurveyorId: WP_ID }),
				)}`,
			),
		);

		expect(response.status).toBe(405);
		expect(findImpersonationTarget).not.toHaveBeenCalled();
	});
});
