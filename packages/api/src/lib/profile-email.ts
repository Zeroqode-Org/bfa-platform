import { env as serverEnv } from "@bfa-platform/env/server";
import { env as webEnv } from "@bfa-platform/env/web";
import { createClient } from "@supabase/supabase-js";

/**
 * Resolves one profile's email address.
 *
 * `profiles` carries no email column — the address lives in `auth.users`, the
 * same fact `auth-admin.ts`'s own comment gives for why `findUserIdByEmail`
 * has to page the admin user list rather than query a local column. Here the
 * direction is reversed (id known, email wanted), which the admin API answers
 * directly with `getUserById` — no paging needed.
 *
 * Used by the wizard's submit-time distribution (build-plan § 6.5 step 23) to
 * resolve the certifier's own address and the active WP's admin address,
 * neither of which `test_submissions` or `water_purveyors` stores.
 */
export async function resolveProfileEmail(
	profileId: string,
): Promise<string | null> {
	const supabase = createClient(
		webEnv.NEXT_PUBLIC_SUPABASE_URL,
		serverEnv.SUPABASE_SERVICE_ROLE_KEY,
		{ auth: { persistSession: false, autoRefreshToken: false } },
	);

	const { data, error } = await supabase.auth.admin.getUserById(profileId);

	if (error || !data.user?.email) return null;

	return data.user.email;
}
