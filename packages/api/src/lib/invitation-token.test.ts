import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	appBaseUrl,
	buildInviteLink,
	createInvitationToken,
	hashInvitationSecret,
	invitationSecretMatches,
} from "./invitation-token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createInvitationToken", () => {
	it("stores a SHA-256 digest, not a UUID and not the secret", () => {
		const { secret, tokenHash } = createInvitationToken();

		expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(tokenHash).not.toMatch(UUID);
		expect(secret).not.toMatch(UUID);
		expect(tokenHash).not.toBe(secret);
		expect(tokenHash).toBe(hashInvitationSecret(secret));
	});

	it("emits a 256-bit secret", () => {
		const { secret } = createInvitationToken();

		expect(Buffer.from(secret, "base64url")).toHaveLength(32);
	});

	it("does not repeat itself", () => {
		const tokens = new Set(
			Array.from({ length: 200 }, () => createInvitationToken().tokenHash),
		);

		expect(tokens.size).toBe(200);
	});
});

describe("invitationSecretMatches", () => {
	it("accepts the matching secret and nothing else", () => {
		const { secret, tokenHash } = createInvitationToken();

		expect(invitationSecretMatches(secret, tokenHash)).toBe(true);
		expect(invitationSecretMatches(`${secret}x`, tokenHash)).toBe(false);
		expect(invitationSecretMatches(secret, "deadbeef")).toBe(false);
	});
});

/**
 * The base URL is read off `process.env` on every call, so each case starts
 * from a clean slate — whatever the developer's shell or a Vercel build exports
 * is stubbed away — and every stub is undone afterwards.
 */
const URL_VARIABLES = [
	"APP_URL",
	"NEXT_PUBLIC_APP_URL",
	"VERCEL_URL",
	"VERCEL_PROJECT_PRODUCTION_URL",
] as const;

function stubUrlEnv(
	values: Partial<Record<(typeof URL_VARIABLES)[number], string>>,
) {
	for (const [key, value] of Object.entries(values)) {
		vi.stubEnv(key, value);
	}
}

describe("buildInviteLink", () => {
	beforeEach(() => {
		for (const key of URL_VARIABLES) vi.stubEnv(key, undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("builds an absolute link on the configured base URL", () => {
		stubUrlEnv({ APP_URL: "https://app.example.com" });

		const link = buildInviteLink("abc123");

		expect(link).toBe(`${appBaseUrl()}/invite/abc123`);
		expect(link).toBe("https://app.example.com/invite/abc123");
	});

	it("escapes a secret so the path stays a single segment", () => {
		expect(buildInviteLink("a/b")).toContain("/invite/a%2Fb");
	});

	it("prefers APP_URL over the Vercel production domain", () => {
		stubUrlEnv({
			APP_URL: "https://override.example.org",
			VERCEL_PROJECT_PRODUCTION_URL: "example.com",
		});

		expect(buildInviteLink("abc")).toBe(
			"https://override.example.org/invite/abc",
		);
	});

	it("falls back to VERCEL_PROJECT_PRODUCTION_URL over https", () => {
		stubUrlEnv({ VERCEL_PROJECT_PRODUCTION_URL: "example.com" });

		expect(buildInviteLink("abc")).toBe("https://example.com/invite/abc");
	});

	it("treats an empty APP_URL as unset", () => {
		stubUrlEnv({ APP_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "example.com" });

		expect(buildInviteLink("abc")).toBe("https://example.com/invite/abc");
	});

	it("uses localhost only when no production URL is configured", () => {
		expect(buildInviteLink("abc")).toBe("http://localhost:3001/invite/abc");
	});

	it("resolves APP_URL, then NEXT_PUBLIC_APP_URL, then Vercel, then localhost", () => {
		stubUrlEnv({
			APP_URL: "https://app.example.org",
			NEXT_PUBLIC_APP_URL: "https://legacy.example.net",
			VERCEL_PROJECT_PRODUCTION_URL: "example.com",
		});
		expect(buildInviteLink("abc")).toBe("https://app.example.org/invite/abc");

		vi.stubEnv("APP_URL", undefined);
		expect(buildInviteLink("abc")).toBe(
			"https://legacy.example.net/invite/abc",
		);

		vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
		expect(buildInviteLink("abc")).toBe("https://example.com/invite/abc");

		vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", undefined);
		expect(buildInviteLink("abc")).toBe("http://localhost:3001/invite/abc");
	});

	it("keeps NEXT_PUBLIC_APP_URL working on its own, trailing slash dropped", () => {
		stubUrlEnv({ NEXT_PUBLIC_APP_URL: "https://legacy.example.net/" });

		expect(buildInviteLink("abc")).toBe(
			"https://legacy.example.net/invite/abc",
		);
	});

	it("refuses an unsafe legacy NEXT_PUBLIC_APP_URL", () => {
		stubUrlEnv({
			NEXT_PUBLIC_APP_URL: "javascript:alert(1)",
			VERCEL_PROJECT_PRODUCTION_URL: "example.com",
		});

		expect(() => buildInviteLink("abc")).toThrow(/NEXT_PUBLIC_APP_URL/);
	});

	it("never uses the per-deployment VERCEL_URL", () => {
		stubUrlEnv({ VERCEL_URL: "bfa-git-preview-team.vercel.app" });

		expect(buildInviteLink("abc")).toBe("http://localhost:3001/invite/abc");

		stubUrlEnv({ VERCEL_PROJECT_PRODUCTION_URL: "example.com" });

		expect(buildInviteLink("abc")).toBe("https://example.com/invite/abc");
	});

	it.each([
		["https://app.example.com/", "https://app.example.com/invite/abc"],
		["https://app.example.com///", "https://app.example.com/invite/abc"],
		["https://example.com/portal/", "https://example.com/portal/invite/abc"],
		["http://localhost:3001/", "http://localhost:3001/invite/abc"],
	])("normalizes the trailing slash of APP_URL=%s", (appUrl, expected) => {
		stubUrlEnv({ APP_URL: appUrl });

		expect(buildInviteLink("abc")).toBe(expected);
		expect(buildInviteLink("abc")).not.toMatch(/[^:]\/\//);
	});

	it.each([
		["javascript:alert(1)"],
		["data:text/html,<script>alert(1)</script>"],
		["ftp://files.example.com"],
		["/relative/path"],
		["app.example.com"],
		["//app.example.com"],
		["https://user:pass@app.example.com"],
		["https://app.example.com/?next=evil"],
		["https://app.example.com/#fragment"],
	])("refuses APP_URL=%s instead of mailing it", (appUrl) => {
		stubUrlEnv({
			APP_URL: appUrl,
			VERCEL_PROJECT_PRODUCTION_URL: "example.com",
		});

		expect(() => buildInviteLink("abc")).toThrow(/APP_URL/);
	});

	it.each([
		["https://example.com"],
		["example.com/path"],
		["javascript:alert(1)"],
		["exa mple.com"],
	])("refuses VERCEL_PROJECT_PRODUCTION_URL=%s", (hostname) => {
		stubUrlEnv({ VERCEL_PROJECT_PRODUCTION_URL: hostname });

		expect(() => buildInviteLink("abc")).toThrow(
			/VERCEL_PROJECT_PRODUCTION_URL/,
		);
	});

	it("does not leak a stub from one case into the next", () => {
		expect(process.env.APP_URL).toBeUndefined();
		expect(process.env.NEXT_PUBLIC_APP_URL).toBeUndefined();
		expect(process.env.VERCEL_PROJECT_PRODUCTION_URL).toBeUndefined();
	});
});
