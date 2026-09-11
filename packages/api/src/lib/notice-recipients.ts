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
		"Every active customer in your purveyor. Suspended customers are not included.",
	agricultural_only:
		"Active customers on the agricultural rate category only. Suspended customers are not included.",
	past_due_only:
		"Active customers who own at least one assembly the scheduler has marked past due. Each customer is written to once, however many past-due assemblies they own.",
};
