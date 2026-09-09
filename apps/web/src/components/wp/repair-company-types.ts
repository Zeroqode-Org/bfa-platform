import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

/** One row of `repairCompanies.listRepairCompanies`, as the server returns it. */
export type RepairCompany =
	RouterOutputs["repairCompanies"]["listRepairCompanies"][number];

/**
 * The field set both mutations take, minus the row id the update adds. Derived
 * from the router rather than retyped, so the form has to satisfy the same
 * shape the server validates — a field renamed on one side stops compiling on
 * the other.
 */
export type RepairCompanyPayload =
	RouterInputs["repairCompanies"]["createRepairCompany"];

/**
 * The one sentence that explains what deactivation actually does. Shown
 * wherever a company can be deactivated — the form's status field and the
 * table's confirmation — from here, so the two cannot describe it differently.
 */
export const DEACTIVATION_WARNING =
	"Deactivating this company stops it appearing in future failure notices.";
