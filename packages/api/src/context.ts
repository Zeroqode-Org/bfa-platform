import { db } from "@bfa-platform/db";
import { certifiers, profiles, waterPurveyors } from "@bfa-platform/db/schema";
import { env } from "@bfa-platform/env/web";
import {
	createServerClient,
	parseCookieHeader,
	serializeCookieHeader,
} from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { and, asc, eq } from "drizzle-orm";

import { CallerRefusedError } from "./caller-refusal";
import { readVerifiedAuthSession } from "./lib/auth-session";
import {
	type ImpersonationTokenRejection,
	impersonationSecret,
	readImpersonationCookie,
	verifyImpersonationToken,
} from "./lib/impersonation-cookie";

// Re-exported so the refusal vocabulary stays reachable from the module that
// produces it, while the definitions live somewhere a route gate can import
// without pulling in a database handle.
export {
	type CallerRefusal,
	CallerRefusedError,
	callerRefusal,
} from "./caller-refusal";

/**
 * Per-request tRPC context. Builds a cookie-backed Supabase client from the raw
 * request and validates the session against the Auth server — the access token
 * goes through `getUser(jwt)`, so neither the user nor the auth session id is
 * taken from the cookie on trust (see `readVerifiedAuthSession`). Profile-row
 * resolution is deferred to `protectedProcedure`.
 */
export async function createContext(opts: FetchCreateContextFnOptions) {
	const { req, resHeaders } = opts;

	const supabase = createServerClient(
		env.NEXT_PUBLIC_SUPABASE_URL,
		env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
		{
			cookies: {
				getAll() {
					return parseCookieHeader(req.headers.get("cookie") ?? "").map(
						(c) => ({
							name: c.name,
							value: c.value ?? "",
						}),
					);
				},
				setAll(cookiesToSet) {
					for (const { name, value, options } of cookiesToSet) {
						resHeaders.append(
							"set-cookie",
							serializeCookieHeader(name, value, options),
						);
					}
				},
			},
		},
	);

	const { user, sessionId } = await readVerifiedAuthSession(supabase);

	return {
		supabase,
		user,
		authSessionId: sessionId,
		resHeaders,
		// The raw value only. Nothing trusts it until `resolveEffectiveCaller` has
		// verified the signature and re-checked both accounts.
		impersonationToken: readImpersonationCookie(req.headers.get("cookie")),
	};
}

export type Context = {
	supabase: SupabaseClient;
	user: User | null;
	/**
	 * The Auth-server-verified `session_id` of this request's Supabase session.
	 * An impersonation cookie is honoured only in the session it was issued in;
	 * absent means none could be verified, and no cookie is honoured.
	 */
	authSessionId?: string | null;
	resHeaders: Headers;
	/** Raw impersonation cookie, unverified. Absent means none was sent. */
	impersonationToken?: string | null;
};

export type Caller = {
	profileId: string;
	fullName: string | null;
	globalRole: (typeof profiles.$inferSelect)["globalRole"];
	waterPurveyorId: string | null;
	waterPurveyorName: string | null;
	certifierId: string | null;
};

/**
 * Resolves the caller's `profiles` row server-side from `auth.uid()`. Uses the
 * Drizzle service connection, not the anon Supabase client — `profiles` has no
 * RLS policies yet, so a PostgREST read would return nothing. Throws typed
 * `TRPCError`; never returns null to signal a permission failure.
 *
 * Two switches can block an account, not one. `profiles.status` is the
 * platform-wide one a Super-Admin sets. `certifiers.status` is the certifier
 * account's own switch — a water purveyor's block from `/wp/certifiers` no
 * longer touches it, it revokes one authorization — and it is checked here for the same
 * reason the first one is: this function is the only gate between a valid
 * Supabase session and every protected procedure, so a flag that is not read
 * here is a flag the application does not act on. The row policies enforce the
 * same rule for anything arriving through PostgREST — `0006_certifier_policies`
 * folds it into `private.current_global_role()`.
 *
 * The join is a left join, and the certifier column is consulted only for the
 * certifier role. A WP clerk or a Super-Admin has no `certifiers` row, and a
 * blocked one belonging to somebody else must never reach this decision.
 */
export async function resolveCaller(
	_supabase: SupabaseClient,
	user: User | null,
): Promise<Caller> {
	if (!user) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}

	const [row] = await db
		.select({
			id: profiles.id,
			fullName: profiles.fullName,
			globalRole: profiles.globalRole,
			waterPurveyorId: profiles.waterPurveyorId,
			waterPurveyorName: waterPurveyors.companyName,
			status: profiles.status,
			certifierId: certifiers.id,
			certifierStatus: certifiers.status,
		})
		.from(profiles)
		.leftJoin(certifiers, eq(certifiers.profileId, profiles.id))
		.leftJoin(waterPurveyors, eq(waterPurveyors.id, profiles.waterPurveyorId))
		.where(eq(profiles.id, user.id))
		.limit(1);

	if (!row) {
		throw new CallerRefusedError("no_profile", "No profile for this account");
	}

	// One refusal for both switches. Which flag is set is the purveyor's or the
	// Super-Admin's business, not something to be read off a sign-in screen.
	if (
		row.status === "blocked" ||
		(row.globalRole === "certifier" && row.certifierStatus === "blocked")
	) {
		throw new CallerRefusedError("blocked", "Account blocked");
	}

	return {
		profileId: row.id,
		fullName: row.fullName,
		globalRole: row.globalRole,
		waterPurveyorId: row.waterPurveyorId,
		waterPurveyorName: row.waterPurveyorName,
		certifierId: row.certifierId,
	};
}

/**
 * Why an impersonation cookie was ignored. The token-level reasons come from
 * the signature check; the rest are the account re-checks done here.
 */
export type ImpersonationRejection =
	| ImpersonationTokenRejection
	/** Signed for a different Super-Admin than the one signed in. */
	| "actor_mismatch"
	/**
	 * Issued in a different Supabase Auth session than this request's — a cookie
	 * left behind by an earlier sign-in — or no session could be verified.
	 */
	| "session_mismatch"
	/** The signed-in account is no longer a Super-Admin. */
	| "actor_not_super_admin"
	/** The target is gone, blocked, no longer a WP admin, or moved purveyor. */
	| "target_invalid";

export type ActiveImpersonation = {
	targetProfileId: string;
	waterPurveyorId: string;
	expiresAt: Date;
};

export type EffectiveCaller = {
	/**
	 * Who authorization and tenant scoping run as. The impersonated WP admin
	 * while impersonating, otherwise the signed-in account.
	 */
	caller: Caller;
	/** Who is really signed in. Always the Supabase session's own profile. */
	actor: Caller;
	impersonation: ActiveImpersonation | null;
	/** Set when a cookie was sent and ignored, so the caller can clear it. */
	rejection: ImpersonationRejection | null;
};

/** The only role that may be impersonated in this release. */
const IMPERSONATION_TARGET_ROLE = "wp_admin" as const;

const targetColumns = {
	id: profiles.id,
	fullName: profiles.fullName,
	globalRole: profiles.globalRole,
	waterPurveyorId: profiles.waterPurveyorId,
	waterPurveyorName: waterPurveyors.companyName,
	status: profiles.status,
	waterPurveyorStatus: waterPurveyors.status,
};

/**
 * Re-validates the account an impersonation cookie names. Runs on every request
 * rather than trusting what was true when the cookie was issued: an admin
 * blocked, demoted or moved to another purveyor mid-impersonation must stop
 * being usable on the very next call, exactly as they would for themselves.
 */
export async function loadImpersonationTarget(
	targetProfileId: string,
	waterPurveyorId: string,
): Promise<Caller | null> {
	const [row] = await db
		.select(targetColumns)
		.from(profiles)
		.innerJoin(waterPurveyors, eq(waterPurveyors.id, profiles.waterPurveyorId))
		.where(eq(profiles.id, targetProfileId))
		.limit(1);

	if (
		row?.status !== "active" ||
		row.globalRole !== IMPERSONATION_TARGET_ROLE ||
		row.waterPurveyorId !== waterPurveyorId ||
		row.waterPurveyorStatus !== "active"
	) {
		return null;
	}

	return {
		profileId: row.id,
		fullName: row.fullName,
		globalRole: row.globalRole,
		waterPurveyorId: row.waterPurveyorId,
		waterPurveyorName: row.waterPurveyorName,
		certifierId: null,
	};
}

export type ImpersonationTargetLookup =
	| { ok: true; target: Caller }
	| {
			ok: false;
			reason: "wp_not_found" | "wp_blocked" | "no_active_admin";
	  };

/**
 * The account a Super-Admin becomes when they impersonate a purveyor from the
 * WP list: its **earliest-created active `wp_admin`**, the same account the
 * list's Contact column names.
 *
 * The list is of purveyors and the cookie must name a profile, and nothing in
 * the product requirements says which admin to pick when a purveyor has several.
 * Earliest-created is the deterministic, already-visible choice; it never falls
 * back to a sub-admin or an employee. A purveyor with no active admin, or one
 * that is blocked, cannot be impersonated at all.
 */
export async function findImpersonationTarget(
	waterPurveyorId: string,
): Promise<ImpersonationTargetLookup> {
	const [purveyor] = await db
		.select({ status: waterPurveyors.status })
		.from(waterPurveyors)
		.where(eq(waterPurveyors.id, waterPurveyorId))
		.limit(1);

	if (!purveyor) return { ok: false, reason: "wp_not_found" };
	if (purveyor.status !== "active") return { ok: false, reason: "wp_blocked" };

	const [row] = await db
		.select(targetColumns)
		.from(profiles)
		.innerJoin(waterPurveyors, eq(waterPurveyors.id, profiles.waterPurveyorId))
		.where(
			and(
				eq(profiles.waterPurveyorId, waterPurveyorId),
				eq(profiles.globalRole, IMPERSONATION_TARGET_ROLE),
				eq(profiles.status, "active"),
			),
		)
		.orderBy(asc(profiles.createdAt), asc(profiles.id))
		.limit(1);

	if (!row?.waterPurveyorId) return { ok: false, reason: "no_active_admin" };

	return {
		ok: true,
		target: {
			profileId: row.id,
			fullName: row.fullName,
			globalRole: row.globalRole,
			waterPurveyorId: row.waterPurveyorId,
			waterPurveyorName: row.waterPurveyorName,
			certifierId: null,
		},
	};
}

/**
 * The shared effective-identity helper: every protected procedure and every
 * server route gate goes through this, so no feature router ever needs to know
 * impersonation exists.
 *
 * The signed-in account is always resolved first, through `resolveCaller`, so a
 * blocked Super-Admin is refused outright whatever cookie they hold. A cookie is
 * then honoured only when all of these hold:
 *
 * - the signature, shape and lifetime verify (`verifyImpersonationToken`);
 * - it was issued to *this* signed-in profile — a cookie copied into another
 *   browser, or left behind for the next person to sign in, does nothing;
 * - it was issued in *this* Supabase Auth session (`authSessionId`, verified by
 *   the Auth server) — so the same Super-Admin signing in again gets a new
 *   session and the old cookie does nothing, even if every client-side attempt
 *   to delete it failed;
 * - that profile is still a Super-Admin;
 * - the target is still an active `wp_admin` of the same, active purveyor.
 *
 * Anything else leaves the effective caller as the signed-in account and reports
 * why, so the tRPC layer can clear the cookie and log the rejection.
 */
export async function resolveEffectiveCaller(
	supabase: SupabaseClient,
	user: User | null,
	impersonationToken: string | null | undefined,
	authSessionId: string | null | undefined,
): Promise<EffectiveCaller> {
	const actor = await resolveCaller(supabase, user);

	if (!impersonationToken) {
		return { caller: actor, actor, impersonation: null, rejection: null };
	}

	const refuse = (rejection: ImpersonationRejection): EffectiveCaller => ({
		caller: actor,
		actor,
		impersonation: null,
		rejection,
	});

	const verified = verifyImpersonationToken(
		impersonationToken,
		impersonationSecret(),
	);
	if (!verified.ok) return refuse(verified.reason);

	const { claims } = verified;
	if (claims.actorProfileId !== actor.profileId) {
		return refuse("actor_mismatch");
	}
	if (!authSessionId || claims.authSessionId !== authSessionId) {
		return refuse("session_mismatch");
	}
	if (actor.globalRole !== "super_admin") {
		return refuse("actor_not_super_admin");
	}

	const target = await loadImpersonationTarget(
		claims.targetProfileId,
		claims.waterPurveyorId,
	);
	if (!target) return refuse("target_invalid");

	return {
		caller: target,
		actor,
		impersonation: {
			targetProfileId: target.profileId,
			waterPurveyorId: claims.waterPurveyorId,
			expiresAt: claims.expiresAt,
		},
		rejection: null,
	};
}
