import { describe, expect, it } from "vitest";

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

describe("buildInviteLink", () => {
	it("builds an absolute link on the configured base URL", () => {
		const link = buildInviteLink("abc123");

		expect(link).toBe(`${appBaseUrl()}/invite/abc123`);
		expect(link.startsWith("http")).toBe(true);
	});

	it("escapes a secret so the path stays a single segment", () => {
		expect(buildInviteLink("a/b")).toContain("/invite/a%2Fb");
	});
});
