import { protectedProcedure, publicProcedure, router } from "../index";
import { assetsRouter } from "./assets";
import { certifiersRouter } from "./certifiers";
import { customersRouter } from "./customers";
import { dashboardRouter } from "./dashboard";
import { invitationsRouter } from "./invitations";
import { repairCompaniesRouter } from "./repair-companies";
import { submittedTestsRouter } from "./submitted-tests";
import { superAdminRouter } from "./super-admin";

export const appRouter = router({
	superAdmin: superAdminRouter,
	invitations: invitationsRouter,
	customers: customersRouter,
	assets: assetsRouter,
	dashboard: dashboardRouter,
	certifiers: certifiersRouter,
	repairCompanies: repairCompaniesRouter,
	submittedTests: submittedTestsRouter,
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
