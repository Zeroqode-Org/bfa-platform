import { protectedProcedure, publicProcedure, router } from "../index";
import { assetsRouter } from "./assets";
import { certifierRouter } from "./certifier";
import { certifierWizardRouter } from "./certifier-wizard";
import { certifiersRouter } from "./certifiers";
import { contactRouter } from "./contact";
import { customersRouter } from "./customers";
import { dashboardRouter } from "./dashboard";
import { invitationsRouter } from "./invitations";
import { noticesRouter } from "./notices";
import { repairCompaniesRouter } from "./repair-companies";
import { sessionRouter } from "./session";
import { submittedTestsRouter } from "./submitted-tests";
import { superAdminRouter } from "./super-admin";

export const appRouter = router({
	superAdmin: superAdminRouter,
	invitations: invitationsRouter,
	customers: customersRouter,
	assets: assetsRouter,
	dashboard: dashboardRouter,
	certifiers: certifiersRouter,
	certifier: certifierRouter,
	certifierWizard: certifierWizardRouter,
	repairCompanies: repairCompaniesRouter,
	notices: noticesRouter,
	submittedTests: submittedTestsRouter,
	session: sessionRouter,
	contact: contactRouter,
	healthCheck: publicProcedure.query(() => {
		return "OK";
	}),
	// The effective identity, plus whether it is borrowed. Deliberately nothing
	// about the cookie itself — no token, no expiry, no signing detail.
	whoami: protectedProcedure.query(({ ctx }) => ({
		profileId: ctx.caller.profileId,
		globalRole: ctx.caller.globalRole,
		waterPurveyorId: ctx.caller.waterPurveyorId,
		impersonating: ctx.impersonation !== null,
	})),
});
export type AppRouter = typeof appRouter;
