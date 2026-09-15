import { trpcClient } from "@/utils/trpc";

export type ImpersonationClearReason = "sign_out" | "sign_in";

/**
 * Asks the server to delete the `httpOnly` impersonation cookie, which the
 * browser cannot touch itself.
 *
 * Called before signing out, so an impersonation cannot outlive the session
 * that started it, and again after signing in, so a sign-out whose request
 * never arrived still cannot be resumed. Never throws: a failed clear must not
 * stop anybody signing out or in, and the other call site is the backstop.
 */
export async function clearImpersonationCookie(
	reason: ImpersonationClearReason,
) {
	try {
		await trpcClient.session.clearImpersonation.mutate({ reason });
	} catch {
		// Deliberately swallowed — see above.
	}
}
