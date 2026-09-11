import "server-only";

/**
 * Server-side gates for every signed-in route. Anonymous visitors are sent to
 * `/login` instead of being shown a shell that cannot be filled with data.
 *
 * Everything here uses `getUser()`, which re-validates the JWT against the
 * Auth server — `getSession()` would trust a cookie the browser could have
 * forged.
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
import { type Caller, resolveCaller } from "@bfa-platform/api/context";
import { redirect } from "next/navigation";

import { landingRouteFor } from "@/lib/landing-route";
import { signInNoticeRoute } from "@/lib/sign-in-notice";
import { createClient } from "@/lib/supabase/server";

/**
 * Who is signed in, as the shells need to render it: the resolved `profiles`
 * row plus the one identifying field that lives on the auth account rather
 * than the profile. `profiles.full_name` is optional and an invited account
 * may never have filled it in, so the email is what guarantees the sidebar can
 * always name somebody.
 */
export type Account = Caller & { email: string | null };

/**
 * The caller's resolved `profiles` row plus their sign-in email, or a redirect
 * to sign-in.
 *
 * Goes through the same helper every protected procedure uses, so a route and
 * its procedures cannot disagree about who somebody is.
 */
export async function requireAccount(): Promise<Account> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) redirect("/login");

	try {
		const caller = await resolveCaller(supabase, user);
		return { ...caller, email: user.email ?? null };
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
