import { db } from "@bfa-platform/db";
import { profiles } from "@bfa-platform/db/schema";
import { env } from "@bfa-platform/env/web";
import {
	createServerClient,
	parseCookieHeader,
	serializeCookieHeader,
} from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { eq } from "drizzle-orm";

/**
 * Per-request tRPC context. Builds a cookie-backed Supabase client from the raw
 * request and validates the session against the Auth server (`getUser`, not
 * `getSession`). Profile-row resolution is deferred to `protectedProcedure`.
 */
export async function createContext(opts: FetchCreateContextFnOptions) {
	const { req, resHeaders } = opts;

	const supabase = createServerClient(
		env.NEXT_PUBLIC_SUPABASE_URL,
		env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
		{
			cookies: {
				getAll() {
					return parseCookieHeader(req.headers.get("cookie") ?? "").map(
						(c) => ({
							name: c.name,
							value: c.value ?? "",
						}),
					);
				},
				setAll(cookiesToSet) {
					for (const { name, value, options } of cookiesToSet) {
						resHeaders.append(
							"set-cookie",
							serializeCookieHeader(name, value, options),
						);
					}
				},
			},
		},
	);

	const {
		data: { user },
	} = await supabase.auth.getUser();

	return { supabase, user, resHeaders };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

export type Caller = {
	profileId: string;
	globalRole: (typeof profiles.$inferSelect)["globalRole"];
	waterPurveyorId: string | null;
};

/**
 * Resolves the caller's `profiles` row server-side from `auth.uid()`. Uses the
 * Drizzle service connection, not the anon Supabase client — `profiles` has no
 * RLS policies yet, so a PostgREST read would return nothing. Throws typed
 * `TRPCError`; never returns null to signal a permission failure.
 */
export async function resolveCaller(
	_supabase: SupabaseClient,
	user: User | null,
): Promise<Caller> {
	if (!user) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}

	const [row] = await db
		.select({
			id: profiles.id,
			globalRole: profiles.globalRole,
			waterPurveyorId: profiles.waterPurveyorId,
			status: profiles.status,
		})
		.from(profiles)
		.where(eq(profiles.id, user.id))
		.limit(1);

	if (!row) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "No profile for this account",
		});
	}

	if (row.status === "blocked") {
		throw new TRPCError({ code: "FORBIDDEN", message: "Account blocked" });
	}

	return {
		profileId: row.id,
		globalRole: row.globalRole,
		waterPurveyorId: row.waterPurveyorId,
	};
}
