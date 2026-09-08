import "server-only";

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
