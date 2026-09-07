import { protectedProcedure, publicProcedure, router } from "../index";
import { superAdminRouter } from "./super-admin";

export const appRouter = router({
	superAdmin: superAdminRouter,
	healthCheck: publicProcedure.query(() => {
		return "OK";
	}),
	whoami: protectedProcedure.query(({ ctx }) => ({
		profileId: ctx.caller.profileId,
		globalRole: ctx.caller.globalRole,
		waterPurveyorId: ctx.caller.waterPurveyorId,
	})),
});
export type AppRouter = typeof appRouter;
