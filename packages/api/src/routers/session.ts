import { z } from "zod";

import { publicProcedure, router } from "../index";
import {
	impersonationSecret,
	serializeClearedImpersonationCookie,
	verifyImpersonationToken,
} from "../lib/impersonation-cookie";

export const sessionRouter = router({
	/**
	 * Clears the impersonation cookie around a sign-out or a sign-in.
	 *
	 * The cookie is `httpOnly`, so the browser cannot delete it itself, and
	 * Supabase's `signOut` knows nothing about it. Without this a Super-Admin who
	 * signs out mid-impersonation, and signs back in within the hour, would land
	 * straight back inside the old impersonation.
	 *
	 * Public on purpose. It changes nothing but the caller's own cookie jar, and
	 * it has to work for a session that is about to end (sign-out) or has only
	 * just begun (sign-in, the backstop for a sign-out whose request never
	 * arrived). It grants nothing: the effective identity is still decided by
	 * `resolveEffectiveCaller` on the next request.
	 *
	 * `impersonation_ended` is logged only when the cookie verifies *and* was
	 * issued to the account signed in on this request — so a stale or foreign
	 * cookie is cleared silently rather than recorded as somebody's session.
	 */
	clearImpersonation: publicProcedure
		.input(z.object({ reason: z.enum(["sign_out", "sign_in"]) }))
		.mutation(({ ctx, input }) => {
			ctx.resHeaders.append(
				"set-cookie",
				serializeClearedImpersonationCookie(),
			);

			if (!ctx.impersonationToken) return { cleared: false };

			const verified = verifyImpersonationToken(
				ctx.impersonationToken,
				impersonationSecret(),
			);

			if (
				verified.ok &&
				ctx.user &&
				verified.claims.actorProfileId === ctx.user.id
			) {
				console.log(
					JSON.stringify({
						event: "impersonation_ended",
						actor_id: verified.claims.actorProfileId,
						target_profile_id: verified.claims.targetProfileId,
						wp_id: verified.claims.waterPurveyorId,
						reason: input.reason,
						timestamp: new Date().toISOString(),
					}),
				);
			}

			return { cleared: true };
		}),
});
