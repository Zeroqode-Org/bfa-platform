import "server-only";

import { type Caller, resolveCaller } from "@bfa-platform/api/context";
import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/**
 * Server-side gate for every signed-in route. Sends anonymous visitors to
 * `/login` instead of rendering a shell they cannot fill with data.
 *
 * Uses `getUser()`, which re-validates the JWT against the Auth server —
 * `getSession()` would trust a cookie the browser could have forged.
 *
 * Deliberately not `middleware.ts`: Next runs middleware on the Edge runtime,
 * which the project's portability guardrails rule out. The trade-off is that
 * nothing refreshes an expiring session server-side — the browser client does
 * it and rewrites the cookies.
 *
 * This is a UX gate, not the authorization boundary: every tRPC procedure
 * still resolves the caller and checks the role for itself.
 */
export async function requireUser(): Promise<User> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) redirect("/login");

	return user;
}

/**
 * Server-side gate for a route that only certain roles may see at all.
 *
 * Resolves the caller's `profiles` row through the same helper every protected
 * procedure uses, so a route and its procedures cannot disagree about who
 * somebody is. A signed-in user in the wrong role goes to the workspace picker
 * rather than to `/login` — they are authenticated, just not here.
 *
 * Still not the authorization boundary: it decides what to render. Every
 * procedure behind the screen checks the role again for itself, because a
 * hidden button is not a permission.
 */
export async function requireGlobalRole(
	allowed: readonly Caller["globalRole"][],
): Promise<Caller> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) redirect("/login");

	let caller: Caller;
	try {
		caller = await resolveCaller(supabase, user);
	} catch {
		// Signed in with no usable profile — blocked, or an account whose
		// redemption never completed. There is nothing here for them.
		redirect("/login");
	}

	if (!allowed.includes(caller.globalRole)) redirect("/");

	return caller;
}
