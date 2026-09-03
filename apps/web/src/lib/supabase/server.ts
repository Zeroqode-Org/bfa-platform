import "server-only";

import { env } from "@bfa-platform/env/web";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Request-scoped Supabase client (anon key, RLS-enforced) for Server
 * Components, Route Handlers and Server Actions. Reads/writes the session
 * through the Next.js cookie store.
 *
 * The tRPC layer does NOT use this — it builds its own client from the raw
 * request in `packages/api/src/context.ts`.
 */
export async function createClient() {
	const cookieStore = await cookies();

	return createServerClient(
		env.NEXT_PUBLIC_SUPABASE_URL,
		env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
		{
			cookies: {
				getAll() {
					return cookieStore.getAll();
				},
				setAll(cookiesToSet) {
					try {
						for (const { name, value, options } of cookiesToSet) {
							cookieStore.set(name, value, options);
						}
					} catch {
						// Called from a Server Component render, where the cookie store is
						// read-only. Safe to ignore — session refresh happens in Route
						// Handlers / Server Actions (and, later, middleware).
					}
				},
			},
		},
	);
}
