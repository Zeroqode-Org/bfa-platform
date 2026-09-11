import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

/** One row of `assets.listAssets`, as the server returns it. */
export type Asset = RouterOutputs["assets"]["listAssets"]["rows"][number];

/** One asset with its full occupancy history. */
export type AssetDetail = RouterOutputs["assets"]["getAsset"];

/** One row of that history. */
export type AssetAssignment = AssetDetail["assignments"][number];

/**
 * The field set both mutations take, minus the row id the update adds. Derived
 * from the router rather than retyped, so the eight assembly types the server
 * accepts are the same union the form has to satisfy.
 */
export type AssetPayload = Omit<RouterInputs["assets"]["updateAsset"], "id">;

/**
 * What registering an asset sends: the shared fields plus an optional first
 * occupant. Only the create path carries a customer — on an existing asset the
 * pointer moves through `assignCustomer`, which has occupancy to close.
 */
export type CreateAssetPayload = RouterInputs["assets"]["createAsset"];

/** One choice in the optional customer picker on the add-asset form. */
export type AssetCustomerOption = {
	id: string;
	name: string;
	status: "active" | "suspended";
};

/** The status the scheduler computes; never a value the form offers. */
export type AssetStatus = Asset["assetStatus"];

/**
 * Status wording and colour, from the design system's three tint pairs. Kept
 * here rather than in the table so the detail view and the table cannot label
 * the same row differently.
 */
export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
	active: "Active",
	due_soon: "Due soon",
	past_due: "Past due",
};

export const ASSET_STATUS_VARIANTS = {
	active: "success",
	due_soon: "warning",
	past_due: "danger",
} as const;

/** The eight assembly types, in the order the PRD and the wizard list them. */
export const BFA_TYPE_LABELS = {
	RP: "RP",
	RPDA: "RPDA",
	"RPDA-2": "RPDA-2",
	DC: "DC",
	DCDA: "DCDA",
	"DCDA-2": "DCDA-2",
	PVB: "PVB",
	SVB: "SVB",
} as const;

/**
 * What a suspended occupant means for the asset it occupies. Shown wherever an
 * asset's current customer is displayed, from here, so the table and the detail
 * view cannot describe it differently.
 */
export const SUSPENDED_CUSTOMER_NOTE =
	"This asset's automated email is paused while its customer is suspended.";

/**
 * What pressing "Attach customer" should do next.
 *
 * A pure statement of the rule so it can be read and tested without driving a
 * modal: nothing happens for a customer who is already attached or for no
 * choice at all; a suspended customer needs a confirmation first, because
 * attaching one stops the asset's automated email entirely; anything else goes
 * straight through. `assignCustomer` enforces the same three outcomes — this is
 * the convenience half, and the procedure is the boundary.
 */
export function nextAssignAction({
	customer,
	currentCustomerId,
	suspensionConfirmed,
}: {
	customer: { id: string; status: "active" | "suspended" } | undefined;
	currentCustomerId: string | null;
	suspensionConfirmed: boolean;
}) {
	if (!customer || customer.id === currentCustomerId) return "blocked" as const;

	if (customer.status === "suspended" && !suspensionConfirmed) {
		return "confirm-suspended" as const;
	}

	return "assign" as const;
}

/**
 * Where a failed asset mutation's message belongs on the form.
 *
 * `createAsset` and `updateAsset` raise `CONFLICT` for exactly one reason — the
 * BIN is already in use in this purveyor — so the code is a real signal about
 * which field is at fault, and the message goes under that input rather than
 * into the form-wide banner. Reading the code beats matching on the wording:
 * the sentence can be rewritten without silently moving the message.
 */
export function assetFormErrors(
	error: { message: string; data?: { code?: string | null } | null } | null,
) {
	if (!error) return {};

	return error.data?.code === "CONFLICT"
		? { binErrorMessage: error.message }
		: { errorMessage: error.message };
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	// The column is a Postgres `date` — a calendar day with no time and no zone.
	// Formatting it in the reader's local zone would move a test due on the 1st
	// to the 31st for anyone west of UTC, so it is read back as UTC.
	timeZone: "UTC",
});

/** A `YYYY-MM-DD` column as a date a person reads. */
export function formatAssetDate(value: string | null) {
	if (!value) return "—";

	return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}
