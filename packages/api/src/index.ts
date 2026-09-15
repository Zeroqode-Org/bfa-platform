import { initTRPC, TRPCError } from "@trpc/server";

import { refusalErrorData } from "./caller-refusal";
import type { Context } from "./context";
import { resolveEffectiveCaller } from "./context";
import {
	IMPERSONATION_COOKIE_NAME,
	serializeClearedImpersonationCookie,
} from "./lib/impersonation-cookie";

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

/**
 * Resolves who the request runs as, through the one shared helper.
 *
 * `ctx.caller` is the *effective* identity — the impersonated WP admin while a
 * Super-Admin is impersonating, otherwise the signed-in account — and is what
 * every role check and tenant scope below reads. `ctx.actor` is always the real
 * signed-in account, for the few places that must know who is really acting.
 *
 * A cookie that was sent but ignored is cleared on the response, so a tampered,
 * expired or orphaned value is logged once rather than on every request.
 *
 * Once per response, not once per procedure: a batched HTTP request shares one
 * `resHeaders` across all of its procedures, and this middleware runs for each.
 * The guard also keeps a clear from landing *after* a `startImpersonation` in
 * the same batch has set a fresh cookie, which would silently undo it.
 */
const enforceCaller = t.middleware(async ({ ctx, next }) => {
	const { caller, actor, impersonation, rejection } =
		await resolveEffectiveCaller(
			ctx.supabase,
			ctx.user,
			ctx.impersonationToken,
		);

	const responseAlreadySetsCookie = ctx.resHeaders
		.getSetCookie()
		.some((line) => line.startsWith(`${IMPERSONATION_COOKIE_NAME}=`));

	if (rejection && !responseAlreadySetsCookie) {
		ctx.resHeaders.append("set-cookie", serializeClearedImpersonationCookie());
		// The reason only — never the cookie value.
		console.log(
			JSON.stringify({
				event: "impersonation_cookie_rejected",
				actor_id: actor.profileId,
				reason: rejection,
				timestamp: new Date().toISOString(),
			}),
		);
	}

	// `actor_id` stays the real signed-in account, so this line attributes every
	// impersonated request to the Super-Admin behind it.
	console.log(
		JSON.stringify({
			event: "caller_resolved",
			actor_id: actor.profileId,
			effective_profile_id: caller.profileId,
			wp_id: caller.waterPurveyorId,
			role: caller.globalRole,
			impersonating: impersonation !== null,
			timestamp: new Date().toISOString(),
		}),
	);

	return next({ ctx: { ...ctx, caller, actor, impersonation } });
});

/** Every procedure that touches tenant data. Resolves the caller server-side. */
export const protectedProcedure = t.procedure.use(enforceCaller);

/**
 * Cross-tenant Super-Admin procedures. The role is checked here rather than
 * left to a row policy: the Drizzle connection is privileged, so the procedure
 * layer is the authorization boundary. Declared with an inline middleware so it
 * inherits `ctx.caller` from `protectedProcedure`.
 *
 * Checks the effective caller, so a Super-Admin who is impersonating a purveyor
 * has none of these powers until they exit — they see exactly what that
 * purveyor's admin sees.
 */
export const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
	if (ctx.caller.globalRole !== "super_admin") {
		throw new TRPCError({ code: "FORBIDDEN", message: "Super-Admin only" });
	}
	return next({ ctx });
});

/**
 * Procedures only the real, signed-in Super-Admin may call *whatever identity
 * they are currently acting as* — in practice, ending an impersonation, which
 * by definition runs while the effective caller is somebody else. Reads
 * `ctx.actor`, never `ctx.caller`.
 */
export const superAdminActorProcedure = protectedProcedure.use(
	({ ctx, next }) => {
		if (ctx.actor.globalRole !== "super_admin") {
			throw new TRPCError({ code: "FORBIDDEN", message: "Super-Admin only" });
		}
		return next({ ctx });
	},
);

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

export { TRPCError };
