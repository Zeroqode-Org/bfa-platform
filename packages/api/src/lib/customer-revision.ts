/**
 * The optimistic lock on a customer record, and the sentence a person is told
 * when their copy is out of date.
 *
 * `customers.revision` (0020) is bumped by every write that changes the row:
 * the WP's own save, and the AG renewal notice moving `ag_renewal_date` on a
 * year after a delivery (Workflow 2). `updateCustomer` takes the revision the
 * form was opened with and refuses a save that no longer matches, because the
 * form submits the whole record — without the check, a form opened before the
 * annual transition would put the old renewal date back and queue a second
 * email for a day that has already passed.
 *
 * Import-free on purpose, exactly like `email-uniqueness.ts`: the web app
 * tells this `CONFLICT` apart from the duplicate-address one by comparing the
 * message, and it must be able to do that without pulling a router — and its
 * database — into the browser bundle.
 */

export const CUSTOMER_STALE_MESSAGE =
	"This customer was changed after you opened this form. Close it, reopen the customer, and apply your change again.";

/** Whether a failed mutation is the stale-record conflict rather than a duplicate address. */
export function isStaleCustomerError(error: {
	message: string;
	data?: { code?: string | null } | null;
}): boolean {
	return (
		error.data?.code === "CONFLICT" && error.message === CUSTOMER_STALE_MESSAGE
	);
}
