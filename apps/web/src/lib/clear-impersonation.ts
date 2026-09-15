import { trpcClient } from "@/utils/trpc";

export type ImpersonationClearReason = "sign_out" | "sign_in";

/**
 * Asks the server to delete the `httpOnly` impersonation cookie, which the
 * browser cannot touch itself. Resolves `true` once the server has answered —
 * its response is what carries the clearing `Set-Cookie` — and `false` when the
 * request failed for any reason. Never throws, and never exposes why: the cookie
 * and its contents are none of the page's business.
 *
 * Housekeeping, not the security boundary. The server binds the cookie to the
 * Supabase Auth session it was issued in, so a cookie left over from an earlier
 * sign-in is ignored on every request whether or not this ever succeeds. The
 * two callers still treat a failure differently:
 *
 * - **Sign-out** ignores it. Somebody asking to leave must be able to leave.
 * - **Sign-in** stops before navigating and asks the person to retry — see
 *   `LoginForm` — so a failure is visible rather than silent.
 */
export async function clearImpersonationCookie(
	reason: ImpersonationClearReason,
): Promise<boolean> {
	try {
		await trpcClient.session.clearImpersonation.mutate({ reason });
		return true;
	} catch {
		return false;
	}
}
