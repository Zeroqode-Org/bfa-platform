import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Invite tokens.
 *
 * A UUID is not a credential: v4 carries 122 bits from a generator with no
 * stated cryptographic guarantee, and it is routinely logged, indexed and
 * pasted around as an identifier. An invite link is a bearer credential, so it
 * gets one — 256 bits from `randomBytes`.
 *
 * Only the SHA-256 digest of that secret is stored. The link carries the secret;
 * `invitations.token` holds the digest, so a dump of the table yields nothing
 * anyone can redeem. Lookup stays a single hit on the unique index because the
 * digest is deterministic. SHA-256 is FIPS-approved, which the project's crypto
 * rule requires.
 */

/** 32 bytes — 256 bits — of CSPRNG output, base64url for a clean URL. */
const SECRET_BYTES = 32;

export type InvitationToken = {
	/** Goes in the invite link. Never stored. */
	secret: string;
	/** Goes in `invitations.token`. Never leaves the server. */
	tokenHash: string;
};

export function createInvitationToken(): InvitationToken {
	const secret = randomBytes(SECRET_BYTES).toString("base64url");

	return { secret, tokenHash: hashInvitationSecret(secret) };
}

/** SHA-256 of the secret, lowercase hex. */
export function hashInvitationSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time digest comparison, for the callers that hold both sides. The
 * database lookup itself is an indexed equality match on a digest, which leaks
 * nothing useful about a secret it never sees.
 */
export function invitationSecretMatches(
	secret: string,
	tokenHash: string,
): boolean {
	const candidate = Buffer.from(hashInvitationSecret(secret), "hex");
	const expected = Buffer.from(tokenHash, "hex");

	if (candidate.length !== expected.length) return false;

	return timingSafeEqual(candidate, expected);
}

/**
 * Absolute base URL for links in outbound mail.
 *
 * From the environment, never hardcoded, with a localhost default so the console
 * driver prints a link a developer can click without configuring anything. The
 * dev port matches `apps/web`'s `next dev --port 3001`.
 */
export function appBaseUrl(): string {
	const configured = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;

	return (configured ?? "http://localhost:3001").replace(/\/+$/, "");
}

/** The URL an invitee opens. Carries the secret, not the stored digest. */
export function buildInviteLink(secret: string): string {
	return `${appBaseUrl()}/invite/${encodeURIComponent(secret)}`;
}
