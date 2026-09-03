import { env } from "@bfa-platform/env/web";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client (anon key, RLS-enforced). Safe to call from any
 * Client Component — `createBrowserClient` memoizes internally.
 */
export function createClient() {
	return createBrowserClient(
		env.NEXT_PUBLIC_SUPABASE_URL,
		env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
	);
}
