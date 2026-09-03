import { protectedProcedure, publicProcedure, router } from "../index";

export const appRouter = router({
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
