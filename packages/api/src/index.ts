import { initTRPC, TRPCError } from "@trpc/server";

import { refusalErrorData } from "./caller-refusal";
import type { Caller, Context } from "./context";
import { resolveCaller } from "./context";

/**
 * A refused caller carries its reason onto the wire.
 *
 * Without this the browser sees a `FORBIDDEN` and a sentence. It cannot tell a
 * blocked account — which should take the person to the sign-in screen with an
 * explanation — from an ordinary permission error, which should not. The
 * message is copy and will be rewritten; the value will not.
 */
export const t = initTRPC.context<Context>().create({
	errorFormatter({ shape, error }) {
		const refusal = refusalErrorData(error);

		return refusal ? { ...shape, data: { ...shape.data, ...refusal } } : shape;
	},
});

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

/** The three roles that belong to a water purveyor. Certifiers do not. */
const WP_ROLES = ["wp_admin", "wp_sub_admin", "wp_employee"] as const;

/**
 * Tenant-scoped Water Purveyor procedures. Same reasoning as
 * `superAdminProcedure`: the Drizzle connection is privileged, so the check
 * belongs here rather than in a row policy.
 *
 * Two things are enforced, not one. The role has to be a WP role — a Super-Admin
 * or a certifier is refused rather than quietly given an empty list — and the
 * profile has to carry a purveyor. A WP role with a null `water_purveyor_id` is
 * a broken row, and every query below scopes by that id, so letting it through
 * would turn a data problem into an unscoped read.
 *
 * The narrowed `waterPurveyorId: string` it puts back on the context is the
 * point: downstream procedures cannot forget the null case, because by then
 * there isn't one.
 */
export const wpProcedure = protectedProcedure.use(({ ctx, next }) => {
	const { globalRole, waterPurveyorId } = ctx.caller;

	if (!(WP_ROLES as readonly string[]).includes(globalRole)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Water Purveyor only",
		});
	}

	if (!waterPurveyorId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "No water purveyor on this account",
		});
	}

	return next({
		ctx: { ...ctx, caller: { ...ctx.caller, waterPurveyorId } },
	});
});

/**
 * Certifier-scoped procedures. Same reasoning as `wpProcedure`: the Drizzle
 * connection is privileged, so the role check and the narrowing both belong
 * here, not in a row policy. A certifier account without a `certifiers` row is
 * a broken invite/redemption, not a caller this task's queries can serve — every
 * query below scopes by `certifierId`, so letting a null through would turn
 * that data problem into an unscoped read, exactly as `wpProcedure` reasons for
 * `waterPurveyorId`.
 */
export const certifierProcedure = protectedProcedure.use(({ ctx, next }) => {
	const { globalRole, certifierId } = ctx.caller;

	if (globalRole !== "certifier") {
		throw new TRPCError({ code: "FORBIDDEN", message: "Certifier only" });
	}

	if (!certifierId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "No certifier record on this account",
		});
	}

	return next({
		ctx: { ...ctx, caller: { ...ctx.caller, certifierId } },
	});
});

export { TRPCError };
