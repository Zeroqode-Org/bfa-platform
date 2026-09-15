import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createImpersonationToken,
	IMPERSONATION_COOKIE_NAME,
	IMPERSONATION_TTL_SECONDS,
	impersonationSecret,
	readImpersonationCookie,
	serializeClearedImpersonationCookie,
	serializeImpersonationCookie,
	verifyImpersonationToken,
} from "./impersonation-cookie";

/**
 * The impersonation cookie on its own — signing, verification and the
 * `Set-Cookie` attributes. No database: whether the *accounts* it names are
 * still usable is `resolveEffectiveCaller`'s job and has its own suite.
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnop";
const OTHER_SECRET = "another-secret-0123456789-abcdefghijk";

const claims = {
	actorProfileId: "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
	targetProfileId: "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b",
	waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
};

const issued = new Date("2026-09-14T12:00:00.000Z");

/** Re-signs an arbitrary payload with the real key, to reach the checks after the signature. */
function signedWith(payload: unknown, secret = SECRET) {
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", secret)
		.update(`v1.${encoded}`)
		.digest("base64url");
	return `v1.${encoded}.${signature}`;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("createImpersonationToken / verifyImpersonationToken", () => {
	it("round-trips the claims and expires after the TTL", () => {
		const { token, expiresAt } = createImpersonationToken(
			claims,
			SECRET,
			issued,
		);

		expect(expiresAt.getTime() - issued.getTime()).toBe(
			IMPERSONATION_TTL_SECONDS * 1000,
		);
		expect(verifyImpersonationToken(token, SECRET, issued)).toEqual({
			ok: true,
			claims: { ...claims, issuedAt: issued, expiresAt },
		});
	});

	it("is three parts, and carries only identifiers", () => {
		const { token } = createImpersonationToken(claims, SECRET, issued);
		const [version, payload] = token.split(".");

		expect(token.split(".")).toHaveLength(3);
		expect(version).toBe("v1");
		expect(
			Object.keys(
				JSON.parse(Buffer.from(payload as string, "base64url").toString()),
			).sort(),
		).toEqual(["actor", "exp", "iat", "target", "wp"]);
		expect(token).not.toContain(SECRET);
	});

	it("refuses a token signed with a different key", () => {
		const { token } = createImpersonationToken(claims, OTHER_SECRET, issued);

		expect(verifyImpersonationToken(token, SECRET, issued)).toEqual({
			ok: false,
			reason: "bad_signature",
		});
	});

	it("refuses a payload edited after signing", () => {
		const { token } = createImpersonationToken(claims, SECRET, issued);
		const [version, , signature] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify({
				actor: claims.actorProfileId,
				target: "00000000-0000-4000-8000-000000000000",
				wp: claims.waterPurveyorId,
				iat: Math.floor(issued.getTime() / 1000),
				exp: Math.floor(issued.getTime() / 1000) + 60,
			}),
		).toString("base64url");

		expect(
			verifyImpersonationToken(
				`${version}.${forged}.${signature}`,
				SECRET,
				issued,
			),
		).toEqual({ ok: false, reason: "bad_signature" });
	});

	it("refuses a truncated or padded signature without throwing", () => {
		const { token } = createImpersonationToken(claims, SECRET, issued);

		expect(
			verifyImpersonationToken(token.slice(0, -4), SECRET, issued),
		).toEqual({ ok: false, reason: "bad_signature" });
		expect(verifyImpersonationToken(`${token}AAAA`, SECRET, issued)).toEqual({
			ok: false,
			reason: "bad_signature",
		});
	});

	it("refuses an expired token", () => {
		const { token } = createImpersonationToken(claims, SECRET, issued);
		const later = new Date(issued.getTime() + IMPERSONATION_TTL_SECONDS * 1000);

		expect(verifyImpersonationToken(token, SECRET, later)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it.each([
		["empty", ""],
		["missing", undefined],
		["one part", "garbage"],
		["four parts", "v1.a.b.c"],
		["wrong version", "v2.a.b"],
		["empty payload", "v1..sig"],
	])("refuses a malformed value (%s)", (_label, value) => {
		expect(verifyImpersonationToken(value, SECRET, issued)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("refuses correctly signed payloads that this build would never issue", () => {
		const iat = Math.floor(issued.getTime() / 1000);

		for (const payload of [
			// Not JSON of the right shape.
			{
				actor: "not-a-uuid",
				target: claims.targetProfileId,
				wp: claims.waterPurveyorId,
				iat,
				exp: iat + 60,
			},
			// Extra claims — e.g. a smuggled role.
			{
				actor: claims.actorProfileId,
				target: claims.targetProfileId,
				wp: claims.waterPurveyorId,
				iat,
				exp: iat + 60,
				role: "super_admin",
			},
			// A lifetime longer than the TTL.
			{
				actor: claims.actorProfileId,
				target: claims.targetProfileId,
				wp: claims.waterPurveyorId,
				iat,
				exp: iat + IMPERSONATION_TTL_SECONDS + 1,
			},
			// Issued in the future.
			{
				actor: claims.actorProfileId,
				target: claims.targetProfileId,
				wp: claims.waterPurveyorId,
				iat: iat + 3600,
				exp: iat + 3700,
			},
		]) {
			expect(
				verifyImpersonationToken(signedWith(payload), SECRET, issued),
			).toEqual({ ok: false, reason: "malformed" });
		}
	});

	it("refuses everything when no key is configured", () => {
		const { token } = createImpersonationToken(claims, SECRET, issued);

		expect(verifyImpersonationToken(token, null, issued)).toEqual({
			ok: false,
			reason: "not_configured",
		});
	});
});

describe("impersonationSecret", () => {
	it("reads IMPERSONATION_COOKIE_SECRET from the environment", () => {
		vi.stubEnv("IMPERSONATION_COOKIE_SECRET", SECRET);
		expect(impersonationSecret()).toBe(SECRET);
	});

	it("treats a missing or short key as not configured", () => {
		expect(impersonationSecret({})).toBeNull();
		expect(impersonationSecret({ IMPERSONATION_COOKIE_SECRET: "" })).toBeNull();
		expect(
			impersonationSecret({ IMPERSONATION_COOKIE_SECRET: "x".repeat(31) }),
		).toBeNull();
	});
});

describe("cookie serialization", () => {
	it("sets an httpOnly, path-wide, lax cookie that lives as long as the token", () => {
		const header = serializeImpersonationCookie("v1.a.b", false);

		expect(header.startsWith(`${IMPERSONATION_COOKIE_NAME}=v1.a.b;`)).toBe(
			true,
		);
		expect(header).toContain("HttpOnly");
		expect(header).toContain("Path=/");
		expect(header).toContain("SameSite=Lax");
		expect(header).toContain(`Max-Age=${IMPERSONATION_TTL_SECONDS}`);
		expect(header).not.toContain("Secure");
	});

	it("adds Secure when asked", () => {
		expect(serializeImpersonationCookie("v1.a.b", true)).toContain("Secure");
	});

	it("clears the cookie with an empty value and Max-Age=0", () => {
		const header = serializeClearedImpersonationCookie(false);

		expect(header.startsWith(`${IMPERSONATION_COOKIE_NAME}=;`)).toBe(true);
		expect(header).toContain("Max-Age=0");
		expect(header).toContain("HttpOnly");
	});

	it("is not a Supabase Auth cookie name", () => {
		expect(IMPERSONATION_COOKIE_NAME.startsWith("sb-")).toBe(false);
	});

	it("reads its own value out of a Cookie header and ignores the rest", () => {
		expect(
			readImpersonationCookie(
				`sb-abc-auth-token=xyz; ${IMPERSONATION_COOKIE_NAME}=v1.a.b; other=1`,
			),
		).toBe("v1.a.b");
		expect(readImpersonationCookie("sb-abc-auth-token=xyz")).toBeNull();
		expect(readImpersonationCookie(`${IMPERSONATION_COOKIE_NAME}=`)).toBeNull();
		expect(readImpersonationCookie(null)).toBeNull();
	});
});
