import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

/** One row of `customers.listCustomers`, as the server returns it. */
export type Customer = RouterOutputs["customers"]["listCustomers"][number];

/**
 * The field set both mutations take, minus the row id the update adds. Derived
 * from the router rather than retyped, so the agricultural rule the server
 * enforces is the same union the form has to satisfy — a form that builds an
 * agricultural payload without a renewal date fails to compile.
 */
export type CustomerPayload = RouterInputs["customers"]["createCustomer"];

/**
 * The one sentence that explains what suspension actually does. Shown wherever
 * a customer can be suspended — the form's status field and the table's
 * confirmation — from here, so the two cannot describe it differently.
 */
export const SUSPENSION_WARNING =
	"Suspending this customer pauses all automated email for their currently assigned assets.";
