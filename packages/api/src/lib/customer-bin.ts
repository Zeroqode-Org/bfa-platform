/**
 * The BIN on the customer form: what it means, and what a person is told when
 * it cannot be honoured.
 *
 * A customer is tied to an assembly by the BIN — the asset's
 * `current_customer_id` is what every automated notice is addressed through
 * (PRD § 9), so a customer who holds no asset is a record no notice can ever
 * reach. The customer form therefore asks for a BIN, and saving it attaches the
 * customer to that asset exactly the way `assets.assignCustomer` does.
 *
 * The rule is "after this save, the customer holds at least one asset": a new
 * customer must name one, and an existing customer must name one only while
 * they hold none.
 *
 * Import-free on purpose, like `email-uniqueness.ts`: the web app routes these
 * refusals to the BIN field by comparing the message, and it must be able to do
 * that without pulling a router — and its database — into the browser bundle.
 */

export const CUSTOMER_BIN_REQUIRED_MESSAGE =
	"Enter the BIN of an assembly this customer occupies — notices reach a customer only through an asset.";

export const CUSTOMER_BIN_NOT_FOUND_MESSAGE =
	"No assembly in this water purveyor has this BIN. Register the asset first, then attach the customer to it.";

/**
 * The asset already has a different occupant. Moving it is allowed — that is
 * how a new tenant takes over a meter — but it redirects the asset's automated
 * email, so it waits for the caller to confirm.
 */
export function customerBinReassignMessage(bin: string, occupantName: string) {
	return `BIN ${bin} is currently attached to ${occupantName}. Attaching it here moves the assembly — and its automated email — to this customer.`;
}

type MutationError = {
	message: string;
	data?: { code?: string | null } | null;
};

/** Whether a failed save belongs under the BIN field rather than the form-wide banner. */
export function isCustomerBinError(error: MutationError): boolean {
	return (
		error.message === CUSTOMER_BIN_REQUIRED_MESSAGE ||
		error.message === CUSTOMER_BIN_NOT_FOUND_MESSAGE ||
		isCustomerBinReassignError(error)
	);
}

/**
 * Whether a failed save is the "this BIN belongs to somebody else" question.
 * `PRECONDITION_FAILED` is the one code the customer procedures raise for it.
 */
export function isCustomerBinReassignError(error: MutationError): boolean {
	return error.data?.code === "PRECONDITION_FAILED";
}
