import "server-only";

import { env as serverEnv } from "@bfa-platform/env/server";
import { env as webEnv } from "@bfa-platform/env/web";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS. Server-only, never expose to the
 * browser. No session cookies: it is not a user client.
 *
 * Nothing in `apps/web` calls this yet. Invite redemption ended up needing its
 * own service-role client inside `packages/api`, where the redemption logic
 * lives — see `packages/api/src/lib/auth-admin.ts`, which wraps it as a narrow
 * port so redemption can be tested without administering real accounts. This
 * factory stays for the app-side service-role work still to come (Storage
 * operations, the setup script's TypeScript successor).
 */
export function createAdminClient() {
	return createClient(
		webEnv.NEXT_PUBLIC_SUPABASE_URL,
		serverEnv.SUPABASE_SERVICE_ROLE_KEY,
		{ auth: { persistSession: false, autoRefreshToken: false } },
	);
}
