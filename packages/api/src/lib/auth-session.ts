import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * The signed-in user *and* which Supabase Auth session they are signed in
 * through, both verified by the Auth server.
 *
 * `sessionId` is the access token's `session_id` claim. Supabase issues a new
 * one for every sign-in and keeps it across token refreshes, so it identifies
 * one authentication session rather than one person. The impersonation cookie
 * is bound to it: a cookie minted in one session is ignored in any other, which
 * is what makes an old cookie useless after a fresh sign-in even when the
 * browser never managed to delete it.
 *
 * How it stays trustworthy: `getSession()` only *reads* the cookie-backed
 * session (refreshing it if expired), which on a server proves nothing. So its
 * access token is then handed to `getUser(jwt)`, which sends that exact token
 * to the Auth server and fails unless the server accepts it — signature, expiry
 * and a live session row. Only after that is the same token's `session_id` read,
 * and only if its `sub` is the user the server returned. A forged or edited
 * token fails `getUser`; a token belonging to somebody else fails the `sub`
 * check.
 */
export type VerifiedAuthSession = {
	user: User | null;
	/** Null when there is no user, or the verified token carries no session id. */
	sessionId: string | null;
};

const SIGNED_OUT: VerifiedAuthSession = { user: null, sessionId: null };

export async function readVerifiedAuthSession(
	supabase: Pick<SupabaseClient, "auth">,
): Promise<VerifiedAuthSession> {
	const {
		data: { session },
	} = await supabase.auth.getSession();
	const accessToken = session?.access_token;
	if (!accessToken) return SIGNED_OUT;

	const {
		data: { user },
		error,
	} = await supabase.auth.getUser(accessToken);
	if (error || !user) return SIGNED_OUT;

	return { user, sessionId: sessionIdFromAccessToken(accessToken, user.id) };
}

/**
 * The `session_id` claim of an access token the Auth server has *already*
 * accepted, provided the token's subject is `userId`. Decoding only — the
 * signature was checked by `getUser`. Never throws.
 */
export function sessionIdFromAccessToken(
	accessToken: string,
	userId: string,
): string | null {
	const payload = accessToken.split(".")[1];
	if (!payload) return null;

	try {
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as { sub?: unknown; session_id?: unknown };

		if (claims.sub !== userId) return null;
		return typeof claims.session_id === "string" && claims.session_id
			? claims.session_id
			: null;
	} catch {
		return null;
	}
}
