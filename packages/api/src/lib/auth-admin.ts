import { env as serverEnv } from "@bfa-platform/env/server";
import { env as webEnv } from "@bfa-platform/env/web";
import { createClient } from "@supabase/supabase-js";

/**
 * The slice of Supabase Auth admin that invite redemption needs.
 *
 * Declared as a port rather than used directly so redemption can be exercised
 * against a real database with a stand-in for the Auth server — creating and
 * deleting throwaway accounts on a shared project to assert a rollback is not
 * something a test suite should do.
 */
export type AuthAdmin = {
	findUserIdByEmail(email: string): Promise<string | null>;
	createUser(input: { email: string; password: string }): Promise<string>;
	/** Compensating action when the redemption transaction rolls back. */
	deleteUser(userId: string): Promise<void>;
};

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

/**
 * Service-role Supabase client. Bypasses RLS and can administer auth users —
 * server-only, never constructed in code that reaches the browser.
 */
function createServiceClient() {
	return createClient(
		webEnv.NEXT_PUBLIC_SUPABASE_URL,
		serverEnv.SUPABASE_SERVICE_ROLE_KEY,
		{ auth: { persistSession: false, autoRefreshToken: false } },
	);
}

export function createAuthAdmin(): AuthAdmin {
	const supabase = createServiceClient();

	return {
		/**
		 * Pages the admin user list looking for one email.
		 *
		 * `profiles` carries no email column — the address lives in `auth.users` —
		 * so there is no local index to answer this. The same paging is what
		 * `packages/db/src/seed.ts` does. It is linear in the number of accounts
		 * and only runs on the redemption path, which is rare by nature; if the
		 * platform ever grows past the page ceiling, the fix is an email column on
		 * `profiles`, not a bigger loop.
		 */
		async findUserIdByEmail(email) {
			const needle = email.trim().toLowerCase();

			for (let page = 1; page <= MAX_PAGES; page += 1) {
				const { data, error } = await supabase.auth.admin.listUsers({
					page,
					perPage: PAGE_SIZE,
				});

				if (error) {
					throw new Error(`Could not list auth users: ${error.message}`);
				}

				const match = data.users.find(
					(user) => user.email?.toLowerCase() === needle,
				);
				if (match) return match.id;
				if (data.users.length < PAGE_SIZE) return null;
			}

			throw new Error(
				"Could not scan the auth user list within the pagination limit",
			);
		},

		async createUser({ email, password }) {
			const { data, error } = await supabase.auth.admin.createUser({
				email,
				password,
				// The invite link is itself proof the address received mail.
				email_confirm: true,
			});

			if (error || !data.user) {
				throw new Error(
					`Could not create the account: ${error?.message ?? "no user returned"}`,
				);
			}

			return data.user.id;
		},

		async deleteUser(userId) {
			const { error } = await supabase.auth.admin.deleteUser(userId);

			if (error) {
				throw new Error(`Could not delete the account: ${error.message}`);
			}
		},
	};
}
