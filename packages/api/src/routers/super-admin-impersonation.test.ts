import { profiles, waterPurveyors } from "@bfa-platform/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditActor, auditActorFields } from "../lib/audit-actor";
import {
	createImpersonationToken,
	IMPERSONATION_TTL_SECONDS,
	verifyImpersonationToken,
} from "../lib/impersonation-cookie";

/**
 * Super-Admin impersonation through the real procedure stack — `enforceCaller`,
 * `protectedProcedure`, `wpProcedure`, `superAdminProcedure` and the two new
 * mutations — with the database replaced by a small in-memory stand-in.
 *
 * The stand-in answers the four query shapes the caller-resolution path issues
 * (the signed-in profile, a named target, a purveyor, a purveyor's admins) from
 * plain fixtures, by reading the bound parameters off Drizzle's `where` clause.
 * That keeps this suite in the default offline `npm test`, so the security rules
 * are checked on every run. What only real SQL can prove — ordering and filters
 * in Postgres — is in the opt-in `super-admin-impersonation.db.test.ts`.
 */

const SECRET = "unit-suite-impersonation-secret-0123456789";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ProfileFixture = {
	id: string;
	fullName: string | null;
	globalRole:
		| "super_admin"
		| "wp_admin"
		| "wp_sub_admin"
		| "wp_employee"
		| "certifier";
	waterPurveyorId: string | null;
	status: "active" | "blocked";
	createdAt: Date;
};

type PurveyorFixture = {
	id: string;
	companyName: string;
	status: "active" | "blocked";
};

const WP_A = "0a000000-0000-4000-8000-00000000000a";
const WP_B = "0b000000-0000-4000-8000-00000000000b";
const WP_BLOCKED = "0c000000-0000-4000-8000-00000000000c";
const WP_NO_ADMIN = "0d000000-0000-4000-8000-00000000000d";
const WP_UNKNOWN = "0e000000-0000-4000-8000-00000000000e";

const ids = {
	superAdmin: "5a000000-0000-4000-8000-000000000001",
	otherSuperAdmin: "5a000000-0000-4000-8000-000000000002",
	blockedSuperAdmin: "5a000000-0000-4000-8000-000000000003",
	adminA: "a0000000-0000-4000-8000-000000000001",
	laterAdminA: "a0000000-0000-4000-8000-000000000002",
	subAdminA: "a0000000-0000-4000-8000-000000000003",
	employeeA: "a0000000-0000-4000-8000-000000000004",
	adminB: "b0000000-0000-4000-8000-000000000001",
	adminBlockedWp: "c0000000-0000-4000-8000-000000000001",
	blockedAdminNoAdminWp: "d0000000-0000-4000-8000-000000000001",
	employeeNoAdminWp: "d0000000-0000-4000-8000-000000000002",
	certifier: "ce000000-0000-4000-8000-000000000001",
};

let purveyorRows: Map<string, PurveyorFixture>;
let profileRows: Map<string, ProfileFixture>;

function seed() {
	purveyorRows = new Map(
		[
			{ id: WP_A, companyName: "Riverside Water District", status: "active" },
			{ id: WP_B, companyName: "Lakeside Utilities", status: "active" },
			{ id: WP_BLOCKED, companyName: "Closed Water Co", status: "blocked" },
			{ id: WP_NO_ADMIN, companyName: "Adminless Water", status: "active" },
		].map((row) => [row.id, row as PurveyorFixture]),
	);

	const day = (n: number) => new Date(Date.UTC(2026, 0, n));
	profileRows = new Map(
		(
			[
				[ids.superAdmin, "Nathan Admin", "super_admin", null, "active", day(1)],
				[
					ids.otherSuperAdmin,
					"Other Admin",
					"super_admin",
					null,
					"active",
					day(1),
				],
				[
					ids.blockedSuperAdmin,
					"Blocked Admin",
					"super_admin",
					null,
					"blocked",
					day(1),
				],
				// Older than the admins on purpose: must never be chosen.
				[ids.subAdminA, "Sub A", "wp_sub_admin", WP_A, "active", day(1)],
				[ids.employeeA, "Employee A", "wp_employee", WP_A, "active", day(1)],
				[ids.adminA, "Riley Purveyor", "wp_admin", WP_A, "active", day(2)],
				[ids.laterAdminA, "Later Admin A", "wp_admin", WP_A, "active", day(3)],
				[ids.adminB, "Admin B", "wp_admin", WP_B, "active", day(2)],
				[
					ids.adminBlockedWp,
					"Closed Admin",
					"wp_admin",
					WP_BLOCKED,
					"active",
					day(2),
				],
				[
					ids.blockedAdminNoAdminWp,
					"Blocked",
					"wp_admin",
					WP_NO_ADMIN,
					"blocked",
					day(2),
				],
				[
					ids.employeeNoAdminWp,
					"Employee",
					"wp_employee",
					WP_NO_ADMIN,
					"active",
					day(2),
				],
				[ids.certifier, "Ada Tester", "certifier", null, "active", day(1)],
			] as const
		).map(([id, fullName, globalRole, waterPurveyorId, status, createdAt]) => [
			id,
			{ id, fullName, globalRole, waterPurveyorId, status, createdAt },
		]),
	);
}

// ---------------------------------------------------------------------------
// In-memory stand-in for the Drizzle connection
// ---------------------------------------------------------------------------

/** Every string bound into a Drizzle SQL condition, in order. */
function boundStrings(node: unknown, found: string[] = []): string[] {
	if (!node || typeof node !== "object") return found;

	const value = (node as { value?: unknown }).value;
	if (
		typeof value === "string" &&
		"encoder" in (node as Record<string, unknown>)
	) {
		found.push(value);
	}

	const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
	if (Array.isArray(chunks)) {
		for (const chunk of chunks) boundStrings(chunk, found);
	}

	return found;
}

type QueryShape = {
	table: unknown;
	joins: ("left" | "inner")[];
	ordered: boolean;
	params: string[];
};

function answer(query: QueryShape): Record<string, unknown>[] {
	const [firstParam] = query.params;

	if (query.table === waterPurveyors) {
		const row = firstParam ? purveyorRows.get(firstParam) : undefined;
		return row ? [{ status: row.status }] : [];
	}

	if (query.table !== profiles) {
		throw new Error("Unexpected table in impersonation unit suite");
	}

	const withPurveyor = (profile: ProfileFixture) => {
		const purveyor = profile.waterPurveyorId
			? purveyorRows.get(profile.waterPurveyorId)
			: undefined;
		return {
			id: profile.id,
			fullName: profile.fullName,
			globalRole: profile.globalRole,
			waterPurveyorId: profile.waterPurveyorId,
			waterPurveyorName: purveyor?.companyName ?? null,
			status: profile.status,
			waterPurveyorStatus: purveyor?.status ?? null,
			certifierStatus: null,
			purveyorExists: Boolean(purveyor),
		};
	};

	// `resolveCaller`: left joins, keyed by the auth user id.
	if (query.joins.includes("left")) {
		const profile = firstParam ? profileRows.get(firstParam) : undefined;
		return profile ? [withPurveyor(profile)] : [];
	}

	// `findImpersonationTarget`: a purveyor's active admins, earliest first.
	if (query.ordered) {
		const [wpId, role, status] = query.params;
		return [...profileRows.values()]
			.filter(
				(profile) =>
					profile.waterPurveyorId === wpId &&
					profile.globalRole === role &&
					profile.status === status,
			)
			.sort(
				(a, b) =>
					a.createdAt.getTime() - b.createdAt.getTime() ||
					a.id.localeCompare(b.id),
			)
			.map(withPurveyor)
			.filter((row) => row.purveyorExists);
	}

	// `loadImpersonationTarget`: one profile, inner-joined to its purveyor.
	const profile = firstParam ? profileRows.get(firstParam) : undefined;
	if (!profile) return [];
	const row = withPurveyor(profile);
	return row.purveyorExists ? [row] : [];
}

function selectBuilder() {
	const query: QueryShape = {
		table: null,
		joins: [],
		ordered: false,
		params: [],
	};

	const builder = {
		from(table: unknown) {
			query.table = table;
			return builder;
		},
		leftJoin() {
			query.joins.push("left");
			return builder;
		},
		innerJoin() {
			query.joins.push("inner");
			return builder;
		},
		where(condition: unknown) {
			query.params = boundStrings(condition);
			return builder;
		},
		orderBy() {
			query.ordered = true;
			return builder;
		},
		limit(count: number) {
			return Promise.resolve(answer(query).slice(0, count));
		},
	};

	return builder;
}

vi.mock("@bfa-platform/db", () => ({
	db: { select: () => selectBuilder() },
}));

vi.mock("@bfa-platform/env/web", () => ({
	env: {
		NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
		NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder",
	},
}));

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

const { protectedProcedure, router, t, wpProcedure } = await import("../index");
const { superAdminRouter } = await import("./super-admin");
const { sessionRouter } = await import("./session");

const testRouter = router({
	superAdmin: superAdminRouter,
	session: sessionRouter,
	probe: router({
		protected: protectedProcedure.query(({ ctx }) => ({
			caller: ctx.caller,
			actorProfileId: ctx.actor.profileId,
			impersonating: ctx.impersonation !== null,
		})),
		wp: wpProcedure.query(({ ctx }) => ({
			profileId: ctx.caller.profileId,
			globalRole: ctx.caller.globalRole,
			waterPurveyorId: ctx.caller.waterPurveyorId,
		})),
		// What every feature router's audit line is built from.
		audit: wpProcedure.mutation(({ ctx }) => auditActorFields(auditActor(ctx))),
	}),
});

const createCaller = t.createCallerFactory(testRouter);

/**
 * Two Supabase Auth sessions. `SESSION_A` is the one every request runs in unless
 * a test says otherwise; `SESSION_B` stands for a later sign-in by the same person.
 */
const SESSION_A = "5e55a000-0000-4000-8000-00000000000a";
const SESSION_B = "5e55b000-0000-4000-8000-00000000000b";

function callerFor(
	profileId: string | null,
	impersonationToken: string | null = null,
	authSessionId: string | null = SESSION_A,
) {
	const resHeaders = new Headers();
	const api = createCaller({
		supabase: {} as never,
		user: profileId ? ({ id: profileId } as never) : null,
		authSessionId,
		resHeaders,
		impersonationToken,
	});
	return { api, resHeaders };
}

/** The `bfa_impersonation` Set-Cookie lines a response carried. */
function impersonationCookies(headers: Headers) {
	return headers
		.getSetCookie()
		.filter((line) => line.startsWith("bfa_impersonation="));
}

function tokenSetBy(headers: Headers) {
	const [line] = impersonationCookies(headers);
	return line?.match(/^bfa_impersonation=([^;]*)/)?.[1];
}

function tokenFor(
	claims: {
		actorProfileId: string;
		targetProfileId: string;
		waterPurveyorId: string;
		authSessionId?: string;
	},
	options: { secret?: string; now?: Date } = {},
) {
	return createImpersonationToken(
		{ authSessionId: SESSION_A, ...claims },
		options.secret ?? SECRET,
		options.now ?? new Date(),
	).token;
}

const validClaims = {
	actorProfileId: ids.superAdmin,
	targetProfileId: ids.adminA,
	waterPurveyorId: WP_A,
};

let logLines: string[];

function logEvents(event: string) {
	return logLines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.event === event);
}

beforeEach(() => {
	seed();
	vi.stubEnv("IMPERSONATION_COOKIE_SECRET", SECRET);
	logLines = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		logLines.push(String(value));
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// startImpersonation
// ---------------------------------------------------------------------------

describe("startImpersonation", () => {
	it.each([
		["a WP admin", ids.adminA],
		["a WP sub-admin", ids.subAdminA],
		["a WP employee", ids.employeeA],
		["a certifier", ids.certifier],
	])("refuses %s at the procedure layer", async (_label, profileId) => {
		const { api, resHeaders } = callerFor(profileId);

		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: WP_A }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(impersonationCookies(resHeaders)).toEqual([]);
		expect(logEvents("impersonation_started")).toEqual([]);
	});

	it("refuses an anonymous request and a blocked Super-Admin", async () => {
		await expect(
			callerFor(null).api.superAdmin.startImpersonation({
				waterPurveyorId: WP_A,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		await expect(
			callerFor(ids.blockedSuperAdmin).api.superAdmin.startImpersonation({
				waterPurveyorId: WP_A,
			}),
		).rejects.toThrow(/blocked/i);
	});

	it("sets a signed httpOnly cookie naming the purveyor's earliest active wp_admin", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: WP_A }),
		).resolves.toMatchObject({
			waterPurveyorId: WP_A,
			waterPurveyorName: "Riverside Water District",
		});

		const [line] = impersonationCookies(resHeaders);
		expect(line).toContain("HttpOnly");
		expect(line).toContain(`Max-Age=${IMPERSONATION_TTL_SECONDS}`);

		const verified = verifyImpersonationToken(tokenSetBy(resHeaders), SECRET);
		expect(verified).toMatchObject({
			ok: true,
			// Not the older sub-admin or employee: only a wp_admin is a target.
			claims: {
				actorProfileId: ids.superAdmin,
				targetProfileId: ids.adminA,
				waterPurveyorId: WP_A,
				// Bound to the auth session the request was verified in.
				authSessionId: SESSION_A,
			},
		});
	});

	it("never touches the Supabase session cookies", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await api.superAdmin.startImpersonation({ waterPurveyorId: WP_A });

		expect(resHeaders.getSetCookie()).toHaveLength(1);
		expect(resHeaders.getSetCookie()[0]).toMatch(/^bfa_impersonation=/);
	});

	it("skips a blocked admin for the next active one", async () => {
		profileRows.set(ids.adminA, {
			...(profileRows.get(ids.adminA) as ProfileFixture),
			status: "blocked",
		});
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await api.superAdmin.startImpersonation({ waterPurveyorId: WP_A });

		expect(
			verifyImpersonationToken(tokenSetBy(resHeaders), SECRET),
		).toMatchObject({ claims: { targetProfileId: ids.laterAdminA } });
	});

	it.each([
		["a blocked purveyor", WP_BLOCKED, "PRECONDITION_FAILED", /blocked/i],
		[
			"a purveyor whose only admin is blocked",
			WP_NO_ADMIN,
			"PRECONDITION_FAILED",
			/no active admin/i,
		],
		["an unknown purveyor", WP_UNKNOWN, "NOT_FOUND", /not found/i],
	])("refuses %s and sets no cookie", async (_label, wpId, code, message) => {
		const { api, resHeaders } = callerFor(ids.superAdmin);

		const attempt = api.superAdmin.startImpersonation({
			waterPurveyorId: wpId,
		});
		await expect(attempt).rejects.toMatchObject({ code });
		await expect(attempt).rejects.toThrow(message);
		expect(impersonationCookies(resHeaders)).toEqual([]);
		expect(logEvents("impersonation_started")).toEqual([]);
	});

	it("validates the purveyor id rather than trusting the client", async () => {
		await expect(
			callerFor(ids.superAdmin).api.superAdmin.startImpersonation({
				waterPurveyorId: "Riverside Water District",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses to start when no signing key is configured", async () => {
		vi.stubEnv("IMPERSONATION_COOKIE_SECRET", "");
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: WP_A }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(impersonationCookies(resHeaders)).toEqual([]);
	});

	it("refuses a Super-Admin who is already impersonating", async () => {
		await expect(
			callerFor(
				ids.superAdmin,
				tokenFor(validClaims),
			).api.superAdmin.startImpersonation({ waterPurveyorId: WP_B }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses to start when the request's auth session could not be verified", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin, null, null);

		await expect(
			api.superAdmin.startImpersonation({ waterPurveyorId: WP_A }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(impersonationCookies(resHeaders)).toEqual([]);
		expect(logEvents("impersonation_started")).toEqual([]);
	});

	it("logs the start with actor and target context, and no secrets", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await api.superAdmin.startImpersonation({ waterPurveyorId: WP_A });

		const [started] = logEvents("impersonation_started");
		expect(started).toMatchObject({
			event: "impersonation_started",
			actor_id: ids.superAdmin,
			target_profile_id: ids.adminA,
			target_role: "wp_admin",
			wp_id: WP_A,
		});
		expect(new Date(String(started?.timestamp)).toISOString()).toBe(
			started?.timestamp,
		);

		const token = tokenSetBy(resHeaders) as string;
		for (const line of logLines) {
			expect(line).not.toContain(token);
			expect(line).not.toContain(token.split(".")[2]);
			expect(line).not.toContain(SECRET);
		}
	});
});

// ---------------------------------------------------------------------------
// Effective caller
// ---------------------------------------------------------------------------

describe("effective caller while impersonating", () => {
	it("runs protected procedures as the impersonated admin, keeping the real actor", async () => {
		const { api } = callerFor(ids.superAdmin, tokenFor(validClaims));

		await expect(api.probe.protected()).resolves.toEqual({
			caller: {
				profileId: ids.adminA,
				fullName: "Riley Purveyor",
				globalRole: "wp_admin",
				waterPurveyorId: WP_A,
				waterPurveyorName: "Riverside Water District",
				certifierId: null,
			},
			actorProfileId: ids.superAdmin,
			impersonating: true,
		});
	});

	it("lets a Super-Admin with no purveyor through wpProcedure, scoped to the target's purveyor", async () => {
		// Without the cookie the same account is refused outright.
		await expect(callerFor(ids.superAdmin).api.probe.wp()).rejects.toThrow(
			/water purveyor only/i,
		);

		await expect(
			callerFor(ids.superAdmin, tokenFor(validClaims)).api.probe.wp(),
		).resolves.toEqual({
			profileId: ids.adminA,
			globalRole: "wp_admin",
			waterPurveyorId: WP_A,
		});
	});

	it("takes away Super-Admin procedures until the impersonation ends", async () => {
		await expect(
			callerFor(
				ids.superAdmin,
				tokenFor(validClaims),
			).api.superAdmin.setWaterPurveyorStatus({
				waterPurveyorId: WP_B,
				status: "blocked",
			}),
		).rejects.toThrow(/super-admin only/i);
	});

	it("attributes every impersonated request to the real Super-Admin in caller_resolved", async () => {
		await callerFor(ids.superAdmin, tokenFor(validClaims)).api.probe.wp();

		expect(logEvents("caller_resolved")).toEqual([
			expect.objectContaining({
				actor_id: ids.superAdmin,
				effective_profile_id: ids.adminA,
				wp_id: WP_A,
				role: "wp_admin",
				impersonating: true,
			}),
		]);
	});

	it("leaves existing behaviour alone without a cookie", async () => {
		await expect(callerFor(ids.adminB).api.probe.wp()).resolves.toEqual({
			profileId: ids.adminB,
			globalRole: "wp_admin",
			waterPurveyorId: WP_B,
		});
		expect(logEvents("caller_resolved")[0]).toMatchObject({
			actor_id: ids.adminB,
			effective_profile_id: ids.adminB,
			impersonating: false,
		});
	});

	it("refuses a blocked Super-Admin outright, whatever cookie they hold", async () => {
		const token = tokenFor({
			...validClaims,
			actorProfileId: ids.blockedSuperAdmin,
		});

		await expect(
			callerFor(ids.blockedSuperAdmin, token).api.probe.protected(),
		).rejects.toThrow(/blocked/i);
	});
});

describe("cookies that must not change the effective caller", () => {
	function tampered() {
		const token = tokenFor(validClaims);
		const [version, payload, signature] = token.split(".") as [
			string,
			string,
			string,
		];
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		const forged = Buffer.from(
			JSON.stringify({ ...claims, target: ids.adminB, wp: WP_B }),
		).toString("base64url");
		return `${version}.${forged}.${signature}`;
	}

	const cases: [string, () => { profileId: string; token: string }, string][] =
		[
			[
				"a tampered payload",
				() => ({ profileId: ids.superAdmin, token: tampered() }),
				"bad_signature",
			],
			[
				"a token signed with another key",
				() => ({
					profileId: ids.superAdmin,
					token: tokenFor(validClaims, {
						secret: "a-completely-different-secret-0123456789",
					}),
				}),
				"bad_signature",
			],
			[
				"an expired token",
				() => ({
					profileId: ids.superAdmin,
					token: tokenFor(validClaims, {
						now: new Date(Date.now() - (IMPERSONATION_TTL_SECONDS + 5) * 1000),
					}),
				}),
				"expired",
			],
			[
				"a malformed value",
				() => ({ profileId: ids.superAdmin, token: "not-a-token" }),
				"malformed",
			],
			[
				"another Super-Admin's cookie",
				() => ({
					profileId: ids.otherSuperAdmin,
					token: tokenFor(validClaims),
				}),
				"actor_mismatch",
			],
			[
				"a cookie from an earlier auth session of the same Super-Admin",
				() => ({
					profileId: ids.superAdmin,
					token: tokenFor({ ...validClaims, authSessionId: SESSION_B }),
				}),
				"session_mismatch",
			],
		];

	it.each(cases)(
		"ignores %s, clears it, and logs why without the value",
		async (_label, build, reason) => {
			const { profileId, token } = build();
			const { api, resHeaders } = callerFor(profileId, token);

			const result = await api.probe.protected();

			expect(result.caller.profileId).toBe(profileId);
			expect(result.caller.globalRole).toBe("super_admin");
			expect(result.impersonating).toBe(false);

			expect(impersonationCookies(resHeaders)).toEqual([
				expect.stringMatching(/^bfa_impersonation=;.*Max-Age=0/),
			]);
			expect(logEvents("impersonation_cookie_rejected")).toEqual([
				expect.objectContaining({ actor_id: profileId, reason }),
			]);
			for (const line of logLines) expect(line).not.toContain(token);
		},
	);

	it("gives a WP employee nothing for a Super-Admin's cookie", async () => {
		const { api } = callerFor(ids.employeeA, tokenFor(validClaims));

		await expect(api.probe.wp()).resolves.toEqual({
			profileId: ids.employeeA,
			globalRole: "wp_employee",
			waterPurveyorId: WP_A,
		});
		expect(logEvents("impersonation_cookie_rejected")[0]).toMatchObject({
			reason: "actor_mismatch",
		});
	});

	it("gives a non-Super-Admin nothing even for a correctly signed cookie of their own", async () => {
		const token = tokenFor({
			actorProfileId: ids.adminA,
			targetProfileId: ids.adminB,
			waterPurveyorId: WP_B,
		});

		await expect(
			callerFor(ids.adminA, token).api.probe.wp(),
		).resolves.toMatchObject({ profileId: ids.adminA, waterPurveyorId: WP_A });
		expect(logEvents("impersonation_cookie_rejected")[0]).toMatchObject({
			reason: "actor_not_super_admin",
		});
	});

	it.each([
		[
			"the target is blocked",
			() =>
				profileRows.set(ids.adminA, {
					...(profileRows.get(ids.adminA) as ProfileFixture),
					status: "blocked",
				}),
		],
		[
			"the target is no longer a wp_admin",
			() =>
				profileRows.set(ids.adminA, {
					...(profileRows.get(ids.adminA) as ProfileFixture),
					globalRole: "wp_employee",
				}),
		],
		[
			"the target moved to another purveyor",
			() =>
				profileRows.set(ids.adminA, {
					...(profileRows.get(ids.adminA) as ProfileFixture),
					waterPurveyorId: WP_B,
				}),
		],
		[
			"the target's purveyor is blocked",
			() =>
				purveyorRows.set(WP_A, {
					...(purveyorRows.get(WP_A) as PurveyorFixture),
					status: "blocked",
				}),
		],
		["the target no longer exists", () => profileRows.delete(ids.adminA)],
	])("stops honouring a valid cookie once %s", async (_label, change) => {
		const token = tokenFor(validClaims);
		change();

		const { api, resHeaders } = callerFor(ids.superAdmin, token);

		await expect(api.probe.wp()).rejects.toThrow(/water purveyor only/i);
		expect(impersonationCookies(resHeaders)).toHaveLength(1);
		expect(logEvents("impersonation_cookie_rejected")[0]).toMatchObject({
			reason: "target_invalid",
		});
	});

	it("clears and logs a rejected cookie once per batched response, not once per procedure", async () => {
		// A batched HTTP request shares one context — and one `resHeaders` — across
		// every procedure in it.
		const expired = tokenFor(validClaims, {
			now: new Date(Date.now() - (IMPERSONATION_TTL_SECONDS + 5) * 1000),
		});
		const { api, resHeaders } = callerFor(ids.superAdmin, expired);

		await Promise.all([api.probe.protected(), api.probe.protected()]);

		expect(impersonationCookies(resHeaders)).toHaveLength(1);
		expect(logEvents("impersonation_cookie_rejected")).toHaveLength(1);
	});

	it("never lets a batched clear undo a fresh startImpersonation", async () => {
		const expired = tokenFor(validClaims, {
			now: new Date(Date.now() - (IMPERSONATION_TTL_SECONDS + 5) * 1000),
		});
		const { api, resHeaders } = callerFor(ids.superAdmin, expired);

		await api.superAdmin.startImpersonation({ waterPurveyorId: WP_B });
		await api.probe.protected();

		const lines = impersonationCookies(resHeaders);
		// Whatever cleared first, the last word is the new cookie.
		expect(lines.at(-1)).not.toMatch(/^bfa_impersonation=;/);
		expect(
			verifyImpersonationToken(
				lines.at(-1)?.match(/^bfa_impersonation=([^;]*)/)?.[1],
				SECRET,
			),
		).toMatchObject({ ok: true, claims: { waterPurveyorId: WP_B } });
	});

	it("ignores every cookie when the signing key is removed", async () => {
		const token = tokenFor(validClaims);
		vi.stubEnv("IMPERSONATION_COOKIE_SECRET", "");

		const result = await callerFor(ids.superAdmin, token).api.probe.protected();

		expect(result.impersonating).toBe(false);
		expect(logEvents("impersonation_cookie_rejected")[0]).toMatchObject({
			reason: "not_configured",
		});
	});
});

// ---------------------------------------------------------------------------
// endImpersonation
// ---------------------------------------------------------------------------

describe("binding to the Supabase Auth session", () => {
	it("a request from a new sign-in does not resume an impersonation whose cookie was never cleared", async () => {
		// The regression: sign-out clear, sign-in clear and local sign-out all
		// failed, so the browser sends the old, correctly signed cookie with a
		// brand-new valid session for the same Super-Admin.
		const oldCookie = tokenFor(validClaims); // issued in SESSION_A

		const { api, resHeaders } = callerFor(ids.superAdmin, oldCookie, SESSION_B);

		await expect(api.probe.wp()).rejects.toThrow(/water purveyor only/i);
		expect(impersonationCookies(resHeaders)).toEqual([
			expect.stringMatching(/^bfa_impersonation=;.*Max-Age=0/),
		]);
		expect(logEvents("impersonation_cookie_rejected")).toEqual([
			expect.objectContaining({
				actor_id: ids.superAdmin,
				reason: "session_mismatch",
			}),
		]);

		const protectedCall = await callerFor(
			ids.superAdmin,
			oldCookie,
			SESSION_B,
		).api.probe.protected();
		expect(protectedCall.impersonating).toBe(false);
		expect(protectedCall.caller.globalRole).toBe("super_admin");

		// Control: the session that started it still acts as the purveyor.
		await expect(
			callerFor(ids.superAdmin, oldCookie, SESSION_A).api.probe.wp(),
		).resolves.toMatchObject({ profileId: ids.adminA, waterPurveyorId: WP_A });
	});

	it("honours no cookie when the request's auth session could not be verified", async () => {
		const { api } = callerFor(ids.superAdmin, tokenFor(validClaims), null);

		const result = await api.probe.protected();

		expect(result.impersonating).toBe(false);
		expect(logEvents("impersonation_cookie_rejected")[0]).toMatchObject({
			reason: "session_mismatch",
		});
	});

	it("a cookie minted by startImpersonation carries the verified session and nothing a client supplied", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin, null, SESSION_B);

		await api.superAdmin.startImpersonation({ waterPurveyorId: WP_A });

		expect(
			verifyImpersonationToken(tokenSetBy(resHeaders), SECRET),
		).toMatchObject({ ok: true, claims: { authSessionId: SESSION_B } });
	});
});

describe("audit attribution while impersonating", () => {
	it("keeps the real Super-Admin as actor_id for an action performed as the WP admin", async () => {
		await expect(
			callerFor(ids.superAdmin, tokenFor(validClaims)).api.probe.audit(),
		).resolves.toEqual({
			actor_id: ids.superAdmin,
			effective_profile_id: ids.adminA,
		});
	});

	it("names the signed-in account twice outside impersonation", async () => {
		await expect(callerFor(ids.adminB).api.probe.audit()).resolves.toEqual({
			actor_id: ids.adminB,
			effective_profile_id: ids.adminB,
		});
	});
});

describe("session.clearImpersonation (sign-out and sign-in)", () => {
	it("clears the cookie on sign-out and logs the end against the real Super-Admin", async () => {
		const token = tokenFor(validClaims);
		const { api, resHeaders } = callerFor(ids.superAdmin, token);

		await expect(
			api.session.clearImpersonation({ reason: "sign_out" }),
		).resolves.toEqual({ cleared: true });

		expect(impersonationCookies(resHeaders)).toEqual([
			expect.stringMatching(/^bfa_impersonation=;.*Max-Age=0.*HttpOnly/),
		]);
		expect(logEvents("impersonation_ended")).toEqual([
			expect.objectContaining({
				actor_id: ids.superAdmin,
				target_profile_id: ids.adminA,
				wp_id: WP_A,
				reason: "sign_out",
			}),
		]);
		for (const line of logLines) {
			expect(line).not.toContain(token);
			expect(line).not.toContain(SECRET);
		}
	});

	it("leaves nothing to resume: the next sign-in runs as the Super-Admin", async () => {
		const { api, resHeaders } = callerFor(
			ids.superAdmin,
			tokenFor(validClaims),
		);

		await api.session.clearImpersonation({ reason: "sign_out" });

		// Max-Age=0 with an empty value: the browser sends nothing next time.
		const remaining = tokenSetBy(resHeaders);
		expect(remaining).toBe("");

		const next = await callerFor(
			ids.superAdmin,
			remaining || null,
		).api.probe.protected();
		expect(next.impersonating).toBe(false);
		expect(next.caller).toMatchObject({
			profileId: ids.superAdmin,
			globalRole: "super_admin",
		});
	});

	it("clears the cookie without a session, and records nobody's session ending", async () => {
		const { api, resHeaders } = callerFor(null, tokenFor(validClaims));

		await expect(
			api.session.clearImpersonation({ reason: "sign_in" }),
		).resolves.toEqual({ cleared: true });
		expect(impersonationCookies(resHeaders)).toHaveLength(1);
		expect(logEvents("impersonation_ended")).toEqual([]);
	});

	it("clears a cookie issued to somebody else without logging it as their session", async () => {
		const { api, resHeaders } = callerFor(ids.adminB, tokenFor(validClaims));

		await api.session.clearImpersonation({ reason: "sign_in" });

		expect(impersonationCookies(resHeaders)).toHaveLength(1);
		expect(logEvents("impersonation_ended")).toEqual([]);
	});

	it("clears a cookie from an earlier auth session without logging it as this session ending", async () => {
		const { api, resHeaders } = callerFor(
			ids.superAdmin,
			tokenFor(validClaims),
			SESSION_B,
		);

		await api.session.clearImpersonation({ reason: "sign_in" });

		expect(impersonationCookies(resHeaders)).toHaveLength(1);
		expect(logEvents("impersonation_ended")).toEqual([]);
	});

	it("still sends the clear when no cookie was sent", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await expect(
			api.session.clearImpersonation({ reason: "sign_out" }),
		).resolves.toEqual({ cleared: false });
		expect(impersonationCookies(resHeaders)).toHaveLength(1);
	});
});

describe("endImpersonation", () => {
	it.each([
		["a WP admin", ids.adminA],
		["a WP employee", ids.employeeA],
		["a certifier", ids.certifier],
	])("refuses %s", async (_label, profileId) => {
		await expect(
			callerFor(profileId).api.superAdmin.endImpersonation(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses a WP admin even when they present a Super-Admin's cookie", async () => {
		await expect(
			callerFor(
				ids.adminA,
				tokenFor(validClaims),
			).api.superAdmin.endImpersonation(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(logEvents("impersonation_ended")).toEqual([]);
	});

	it("clears the cookie, logs the end, and restores the Super-Admin", async () => {
		const token = tokenFor(validClaims);
		const { api, resHeaders } = callerFor(ids.superAdmin, token);

		await expect(api.superAdmin.endImpersonation()).resolves.toEqual({
			ended: true,
		});

		expect(impersonationCookies(resHeaders)).toEqual([
			expect.stringMatching(/^bfa_impersonation=;.*Max-Age=0.*HttpOnly/),
		]);

		const [ended] = logEvents("impersonation_ended");
		expect(ended).toMatchObject({
			event: "impersonation_ended",
			actor_id: ids.superAdmin,
			target_profile_id: ids.adminA,
			wp_id: WP_A,
			reason: "exit",
		});
		expect(new Date(String(ended?.timestamp)).toISOString()).toBe(
			ended?.timestamp,
		);
		for (const line of logLines) {
			expect(line).not.toContain(token);
			expect(line).not.toContain(SECRET);
		}

		// The browser drops the cookie, so the next request carries none.
		const next = await callerFor(ids.superAdmin).api.probe.protected();
		expect(next.caller).toMatchObject({
			profileId: ids.superAdmin,
			globalRole: "super_admin",
			waterPurveyorId: null,
		});
		expect(next.impersonating).toBe(false);
	});

	it("is idempotent for a Super-Admin with nothing to end", async () => {
		const { api, resHeaders } = callerFor(ids.superAdmin);

		await expect(api.superAdmin.endImpersonation()).resolves.toEqual({
			ended: false,
		});
		expect(impersonationCookies(resHeaders)).toHaveLength(1);
		expect(logEvents("impersonation_ended")).toEqual([]);
	});
});
