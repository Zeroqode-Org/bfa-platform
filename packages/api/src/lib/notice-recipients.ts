/**
 * Who a general-info broadcast goes to.
 *
 * Three named audiences, not a query builder. Each one is a predicate the
 * server owns and the client selects by name, so a recipient set can never be
 * described by the browser — only chosen from the list the product defines.
 * `recipientsFor` in `routers/notices.ts` is where each name becomes a query,
 * and it is the only place that happens: the count the composer shows and the
 * loop that sends read the same function.
 *
 * A module of its own, importing nothing, for the same reason
 * `asset-field-limits.ts` is one: the composer is a client component and needs
 * these labels, and a constant that lived beside the Zod shapes would pull Zod
 * into the browser bundle to answer a question that is a lookup.
 */

export const BROADCAST_RECIPIENT_FILTERS = [
	"all_customers",
	"agricultural_only",
	"past_due_only",
] as const;

export type BroadcastRecipientFilter =
	(typeof BROADCAST_RECIPIENT_FILTERS)[number];

export const BROADCAST_FILTER_LABELS: Record<BroadcastRecipientFilter, string> =
	{
		all_customers: "All customers",
		agricultural_only: "Agricultural-rate customers",
		past_due_only: "Customers with a past-due assembly",
	};

/**
 * What each audience actually selects, said plainly under the picker.
 *
 * Two facts are stated rather than left to be assumed, because both surprise
 * people: suspended customers are in none of these, and a customer with several
 * past-due assemblies is written to once.
 */
export const BROADCAST_FILTER_DESCRIPTIONS: Record<
	BroadcastRecipientFilter,
	string
> = {
	all_customers:
		"Every active customer in your purveyor. Suspended customers are not included. Customers who share an email address get one copy between them.",
	agricultural_only:
		"Active customers on the agricultural rate category only. Suspended customers are not included. Customers who share an email address get one copy between them.",
	past_due_only:
		"Active customers who own at least one assembly whose annual test date has passed. Each customer is written to once, however many past-due assemblies they own. Customers who share an email address get one copy between them.",
};

/**
 * One recipient per inbox, the first in the given order.
 *
 * Since 0024 several customers may share an address — every store of one
 * chain on its main-office inbox. A broadcast is the same message for
 * everybody, so writing to that inbox once per customer would deliver the
 * same email five times. Addresses are compared the way they are stored:
 * trimmed and lowercased.
 *
 * The send's delivery line therefore names the kept customer (the first by
 * name) for that inbox; the others on the address received the same message
 * through it and have no line of their own.
 */
export function oneRecipientPerInbox<Row extends { email: string }>(
	rows: readonly Row[],
): Row[] {
	const seen = new Set<string>();

	return rows.filter((row) => {
		const inbox = row.email.trim().toLowerCase();
		if (seen.has(inbox)) return false;
		seen.add(inbox);
		return true;
	});
}
