import { protectedProcedure, publicProcedure, router } from "../index";
import { customersRouter } from "./customers";
import { invitationsRouter } from "./invitations";
import { superAdminRouter } from "./super-admin";

export const appRouter = router({
	superAdmin: superAdminRouter,
	invitations: invitationsRouter,
	customers: customersRouter,
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
