import "server-only";

/**
 * Server-side gates for every signed-in route. Anonymous visitors are sent to
 * `/login` instead of being shown a shell that cannot be filled with data.
 *
 * Everything here goes through `readVerifiedAuthSession`, which sends the
 * session's access token to the Auth server with `getUser(jwt)` — a bare
 * `getSession()` would trust a cookie the browser could have forged. The same
 * verified token yields the auth session id the impersonation cookie is bound
 * to.
 *
 * Deliberately not `middleware.ts`: Next runs middleware on the Edge runtime,
 * which the project's portability guardrails rule out. The trade-off is that
 * nothing refreshes an expiring session server-side — the browser client does
 * it and rewrites the cookies.
 *
 * These are UX gates, not the authorization boundary: every tRPC procedure
 * still resolves the caller and checks the role for itself.
 */

import { callerRefusal } from "@bfa-platform/api/caller-refusal";
import { type Caller, resolveEffectiveCaller } from "@bfa-platform/api/context";
import {
	readVerifiedAuthSession,
	type VerifiedAuthSession,
} from "@bfa-platform/api/lib/auth-session";
import { IMPERSONATION_COOKIE_NAME } from "@bfa-platform/api/lib/impersonation-cookie";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { landingRouteFor } from "@/lib/landing-route";
import { signInNoticeRoute } from "@/lib/sign-in-notice";
import { createClient } from "@/lib/supabase/server";
import type { ImpersonationState } from "@/lib/use-impersonation";

/**
 * Who is signed in, as the shells need to render it: the resolved *effective*
 * `profiles` row plus the one identifying field that lives on the auth account
 * rather than the profile. `profiles.full_name` is optional and an invited
 * account may never have filled it in, so the email is what guarantees the
 * sidebar can always name somebody.
 *
 * While a Super-Admin impersonates, the caller fields are the impersonated WP
 * admin's, `email` is null — the only address on hand is the Super-Admin's own,
 * and showing it under somebody else's name would misstate the session — and
 * `impersonation` carries what the banner needs. Otherwise it is null.
 */
export type Account = Caller & {
	email: string | null;
	impersonation: ImpersonationState | null;
};

/**
 * The caller's resolved effective `profiles` row plus their sign-in email, or a
 * redirect to sign-in.
 *
 * Goes through the same helper every protected procedure uses — including its
 * impersonation handling — so a route and its procedures cannot disagree about
 * who somebody is. A Server Component cannot write cookies, so an invalid
 * impersonation cookie is simply ignored here; the next tRPC response clears it.
 */
export async function requireAccount(): Promise<Account> {
	const supabase = await createClient();
	const { user, sessionId } = await readVerifiedAuthSession(supabase);

	if (!user) redirect("/login");

	return resolveAccount(supabase, user, sessionId);
}

/**
 * The signed-in account, or `null` for a visitor — without redirecting a
 * visitor anywhere. For the one public page that changes with it: `/` shows
 * the landing page to a visitor and forwards an account to its dashboard.
 *
 * One verified session read, the same as {@link requireAccount}: `getUser(jwt)`,
 * not a bare cookie read, so a forged cookie gets the landing page rather than
 * a redirect loop. A signed-in account with no usable profile is still sent to
 * the sign-in notice, exactly as every gate does.
 */
export async function optionalAccount(): Promise<Account | null> {
	const supabase = await createClient();
	const { user, sessionId } = await readVerifiedAuthSession(supabase);

	if (!user) return null;

	return resolveAccount(supabase, user, sessionId);
}

/**
 * The effective account for a verified user, or a redirect to the sign-in
 * notice when the profile cannot be used.
 */
async function resolveAccount(
	supabase: Awaited<ReturnType<typeof createClient>>,
	user: NonNullable<VerifiedAuthSession["user"]>,
	sessionId: string | null,
): Promise<Account> {
	const cookieStore = await cookies();

	try {
		const { caller, impersonation } = await resolveEffectiveCaller(
			supabase,
			user,
			cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value,
			sessionId,
		);

		if (impersonation) {
			return {
				...caller,
				email: null,
				impersonation: {
					waterPurveyorName: caller.waterPurveyorName ?? "Water Purveyor",
				},
			};
		}

		return { ...caller, email: user.email ?? null, impersonation: null };
	} catch (error) {
		// Signed in with no usable profile — blocked, or an account whose
		// redemption never completed. There is nothing in the app for them, but
		// bouncing them to a blank sign-in form makes a correct password look
		// wrong, so the reason rides along and the screen says it.
		//
		// An unrecognised failure falls back to the vaguer of the two notices
		// rather than to no notice at all: something is wrong with the account
		// either way, and silence is the state this exists to end.
		redirect(signInNoticeRoute(callerRefusal(error) ?? "no_profile"));
	}
}

/** The caller alone, for gates that have no use for the account fields. */
export async function requireCaller(): Promise<Caller> {
	return requireAccount();
}

/**
 * Server-side gate for a section only certain roles may see at all.
 *
 * Someone in the wrong role is sent to their own dashboard rather than to
 * `/login` — they are authenticated, just not here. That lands them somewhere
 * useful instead of on a sign-in form for a session they already have.
 *
 * Still not the authorization boundary: it decides what to render. Every
 * procedure behind the screen checks the role again for itself, because a
 * hidden button is not a permission.
 */
export async function requireGlobalRole(
	allowed: readonly Caller["globalRole"][],
): Promise<Account> {
	const caller = await requireAccount();

	if (!allowed.includes(caller.globalRole)) {
		redirect(landingRouteFor(caller.globalRole));
	}

	return caller;
}
