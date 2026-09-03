import "server-only";

import { env as serverEnv } from "@bfa-platform/env/server";
import { env as webEnv } from "@bfa-platform/env/web";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS. Server-only, never expose to the
 * browser. Used by the invite-redemption server action (later work item) and by
 * `scripts/supabase-setup.mjs`. No session cookies: it is not a user client.
 */
export function createAdminClient() {
	return createClient(
		webEnv.NEXT_PUBLIC_SUPABASE_URL,
		serverEnv.SUPABASE_SERVICE_ROLE_KEY,
		{ auth: { persistSession: false, autoRefreshToken: false } },
	);
}
