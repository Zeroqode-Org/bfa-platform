import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * The Super-Admin impersonation cookie.
 *
 * A separate cookie from the Supabase Auth ones, and deliberately not a second
 * session: it names *who the Super-Admin is acting as*, and means nothing
 * without the real Supabase session of the Super-Admin who started it. The
 * shared context helper re-checks that binding, and the target account, on
 * every request — this module only answers "was this value minted by us, for
 * whom, and is it still inside its lifetime".
 *
 * Wire format — three dot-separated parts:
 *
 *     v1.<base64url(JSON claims)>.<base64url(HMAC-SHA-256(secret, "v1.<claims>"))>
 *
 * The claims are identifiers only (actor profile, target profile, purveyor,
 * issued-at, expiry) — nothing secret, and the cookie is `httpOnly` besides.
 * HMAC-SHA-256 is FIPS-approved, which the project's crypto rule requires, and
 * it comes from `node:crypto`, so there is no new dependency. The signature is
 * compared in constant time.
 *
 * Deliberately free of any database or validated-env import, so it can be unit
 * tested on its own and imported from a route gate.
 */

export const IMPERSONATION_COOKIE_NAME = "bfa_impersonation";

/** One hour. Impersonation is a support action, not a way to work all day. */
export const IMPERSONATION_TTL_SECONDS = 60 * 60;

/** Shortest accepted signing secret, in characters. */
export const IMPERSONATION_SECRET_MIN_LENGTH = 32;

const VERSION = "v1";

/** Tolerated clock drift for `iat`, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

const claimsSchema = z
	.object({
		actor: z.uuid(),
		target: z.uuid(),
		wp: z.uuid(),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().positive(),
	})
	.strict();

export type ImpersonationClaims = {
	/** The real Super-Admin's profile id. Must match the live session. */
	actorProfileId: string;
	/** The impersonated `profiles` row. */
	targetProfileId: string;
	/** The purveyor the target belongs to, as it did when this was issued. */
	waterPurveyorId: string;
	issuedAt: Date;
	expiresAt: Date;
};

export type ImpersonationTokenRejection =
	| "not_configured"
	| "malformed"
	| "bad_signature"
	| "expired";

export type ImpersonationTokenResult =
	| { ok: true; claims: ImpersonationClaims }
	| { ok: false; reason: ImpersonationTokenRejection };

/**
 * The signing secret, or null when impersonation is not configured.
 *
 * Read off `process.env` at call time rather than the validated server env, the
 * same way `appBaseUrl` is, so this module stays importable without every
 * server variable. `packages/env/src/server.ts` validates the same variable at
 * startup; the length check runs again here so a `SKIP_ENV_VALIDATION` run
 * still refuses a short key instead of signing with it. Not trimmed, so the two
 * checks measure the same string.
 */
export function impersonationSecret(
	source: Record<string, string | undefined> = process.env,
): string | null {
	const secret = source.IMPERSONATION_COOKIE_SECRET;

	if (!secret || secret.length < IMPERSONATION_SECRET_MIN_LENGTH) return null;

	return secret;
}

function sign(payload: string, secret: string): Buffer {
	return createHmac("sha256", secret).update(`${VERSION}.${payload}`).digest();
}

/** Mints a token for `claims`, valid for `IMPERSONATION_TTL_SECONDS`. */
export function createImpersonationToken(
	claims: {
		actorProfileId: string;
		targetProfileId: string;
		waterPurveyorId: string;
	},
	secret: string,
	now: Date = new Date(),
): { token: string; expiresAt: Date } {
	const iat = Math.floor(now.getTime() / 1000);
	const exp = iat + IMPERSONATION_TTL_SECONDS;

	const payload = Buffer.from(
		JSON.stringify({
			actor: claims.actorProfileId,
			target: claims.targetProfileId,
			wp: claims.waterPurveyorId,
			iat,
			exp,
		}),
		"utf8",
	).toString("base64url");

	return {
		token: `${VERSION}.${payload}.${sign(payload, secret).toString("base64url")}`,
		expiresAt: new Date(exp * 1000),
	};
}

/**
 * Verifies a token's signature, shape and lifetime. Never throws: every way a
 * value can be wrong is a rejection with a reason, and the caller decides what
 * to log. The signature is checked before the payload is parsed, so nothing
 * unsigned is ever handed to `JSON.parse`.
 */
export function verifyImpersonationToken(
	token: string | null | undefined,
	secret: string | null,
	now: Date = new Date(),
): ImpersonationTokenResult {
	if (!secret) return { ok: false, reason: "not_configured" };
	if (!token) return { ok: false, reason: "malformed" };

	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "malformed" };

	const [version, payload, signature] = parts as [string, string, string];
	if (version !== VERSION || !payload || !signature) {
		return { ok: false, reason: "malformed" };
	}

	const expected = sign(payload, secret);
	const actual = Buffer.from(signature, "base64url");

	// A length mismatch is a forgery too, and `timingSafeEqual` throws on one.
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		return { ok: false, reason: "bad_signature" };
	}

	let parsed: z.infer<typeof claimsSchema>;
	try {
		const result = claimsSchema.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		if (!result.success) return { ok: false, reason: "malformed" };
		parsed = result.data;
	} catch {
		return { ok: false, reason: "malformed" };
	}

	const nowSeconds = Math.floor(now.getTime() / 1000);

	// A lifetime longer than this build issues was not issued by this build.
	if (
		parsed.exp <= parsed.iat ||
		parsed.exp - parsed.iat > IMPERSONATION_TTL_SECONDS
	) {
		return { ok: false, reason: "malformed" };
	}
	if (parsed.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
		return { ok: false, reason: "malformed" };
	}
	if (parsed.exp <= nowSeconds) return { ok: false, reason: "expired" };

	return {
		ok: true,
		claims: {
			actorProfileId: parsed.actor,
			targetProfileId: parsed.target,
			waterPurveyorId: parsed.wp,
			issuedAt: new Date(parsed.iat * 1000),
			expiresAt: new Date(parsed.exp * 1000),
		},
	};
}

/**
 * `Secure` everywhere but local development over plain http. `SameSite=Lax`
 * matches the Supabase Auth cookies: the token is only read on same-site
 * requests, and a tRPC mutation cannot be sent cross-site without a preflight.
 */
function attributes(maxAge: number, secure: boolean) {
	return [
		"Path=/",
		`Max-Age=${maxAge}`,
		"HttpOnly",
		"SameSite=Lax",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

function secureCookies() {
	return process.env.NODE_ENV === "production";
}

/** The `Set-Cookie` value that stores `token`. */
export function serializeImpersonationCookie(
	token: string,
	secure: boolean = secureCookies(),
): string {
	return `${IMPERSONATION_COOKIE_NAME}=${token}; ${attributes(IMPERSONATION_TTL_SECONDS, secure)}`;
}

/** The `Set-Cookie` value that removes the cookie. */
export function serializeClearedImpersonationCookie(
	secure: boolean = secureCookies(),
): string {
	return `${IMPERSONATION_COOKIE_NAME}=; ${attributes(0, secure)}`;
}

/** The raw cookie value from a `Cookie` request header, if present. */
export function readImpersonationCookie(
	cookieHeader: string | null | undefined,
): string | null {
	if (!cookieHeader) return null;

	for (const part of cookieHeader.split(";")) {
		const index = part.indexOf("=");
		if (index === -1) continue;
		if (part.slice(0, index).trim() === IMPERSONATION_COOKIE_NAME) {
			return part.slice(index + 1).trim() || null;
		}
	}

	return null;
}
