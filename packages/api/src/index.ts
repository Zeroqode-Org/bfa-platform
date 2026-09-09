import { initTRPC, TRPCError } from "@trpc/server";

import type { Caller, Context } from "./context";
import { resolveCaller } from "./context";

export const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const enforceCaller = t.middleware(async ({ ctx, next }) => {
	const caller: Caller = await resolveCaller(ctx.supabase, ctx.user);

	console.log(
		JSON.stringify({
			event: "caller_resolved",
			actor_id: caller.profileId,
			wp_id: caller.waterPurveyorId,
			role: caller.globalRole,
			timestamp: new Date().toISOString(),
		}),
	);

	return next({ ctx: { ...ctx, caller } });
});

/** Every procedure that touches tenant data. Resolves the caller server-side. */
export const protectedProcedure = t.procedure.use(enforceCaller);

/**
 * Cross-tenant Super-Admin procedures. The role is checked here rather than
 * left to a row policy: the Drizzle connection is privileged, so the procedure
 * layer is the authorization boundary. Declared with an inline middleware so it
 * inherits `ctx.caller` from `protectedProcedure`.
 */
export const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
	if (ctx.caller.globalRole !== "super_admin") {
		throw new TRPCError({ code: "FORBIDDEN", message: "Super-Admin only" });
	}
	return next({ ctx });
});

export { TRPCError };
