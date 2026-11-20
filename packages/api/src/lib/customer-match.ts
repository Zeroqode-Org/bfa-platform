/**
 * Finding a purveyor's customer from what a test recorded: an email and,
 * usually, a name.
 *
 * Until 0024 a customer's email was unique inside its purveyor, so the email
 * alone named exactly one customer. The client asked for the opposite
 * (November 2026): one main-office inbox may serve several businesses — every
 * McDonald's store, every school a management company runs — so several
 * customers can now share an address. The email is still the key; the name
 * decides only between customers who share it:
 *
 * | Customers with the email | Result                                        |
 * |--------------------------|-----------------------------------------------|
 * | none                     | `none` — the caller may create one            |
 * | one                      | that customer, **whatever the name says**     |
 * | several, one by name     | that customer                                 |
 * | several, none by name    | `ambiguous` — nobody is chosen                |
 *
 * Why not "email and name" strictly: a purveyor renames customers (a school
 * becomes "… Inc"), and a certifier who types the name they know would then
 * create a second copy of a customer who already exists. With one customer on
 * the address there is nothing to tell apart, so the name is not asked to.
 *
 * Why `ambiguous` rather than a guess: attaching a valve to the wrong one of
 * several customers on a shared inbox is invisible until a notice names the
 * wrong business. Leaving it unattached is visible — the purveyor sees the test's
 * customer as a suggestion on the asset's page and attaches it by hand.
 *
 * Names are compared trimmed, with runs of whitespace collapsed and case
 * ignored — the differences a person typing a name on site makes without
 * meaning a different customer.
 */

import type { db } from "@bfa-platform/db";
import { customers } from "@bfa-platform/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

export type CustomerCandidate = {
	id: string;
	name: string;
	status: "active" | "suspended";
};

export type CustomerMatch =
	| { kind: "none" }
	| { kind: "match"; customer: CustomerCandidate }
	| { kind: "ambiguous"; candidates: number };

/** A name as it is compared: trimmed, whitespace collapsed, case ignored. */
export function comparableName(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The rule above, over the customers that share one email. Pure, so it is
 * checkable without a database.
 */
export function pickCustomer(
	candidates: readonly CustomerCandidate[],
	name: string | null,
): CustomerMatch {
	if (candidates.length === 0) return { kind: "none" };

	const [only] = candidates;
	if (candidates.length === 1 && only) return { kind: "match", customer: only };

	const wanted = name ? comparableName(name) : null;
	const named = wanted
		? candidates.filter(
				(candidate) => comparableName(candidate.name) === wanted,
			)
		: [];

	const [chosen] = named;
	if (named.length === 1 && chosen) return { kind: "match", customer: chosen };

	return { kind: "ambiguous", candidates: candidates.length };
}

/** Every customer of this purveyor on this email, in a stable order. */
export async function customersWithEmail(
	executor: Pick<typeof db, "select">,
	waterPurveyorId: string,
	email: string,
): Promise<CustomerCandidate[]> {
	return executor
		.select({
			id: customers.id,
			name: customers.name,
			status: customers.status,
		})
		.from(customers)
		.where(
			and(
				eq(customers.waterPurveyorId, waterPurveyorId),
				sql`lower(btrim(${customers.email})) = ${email}`,
			),
		)
		.orderBy(asc(customers.createdAt), asc(customers.id));
}

/** The customer this email and name point at, by the rule above. */
export async function matchCustomer(
	executor: Pick<typeof db, "select">,
	waterPurveyorId: string,
	{ email, name }: { email: string; name: string | null },
): Promise<CustomerMatch> {
	return pickCustomer(
		await customersWithEmail(executor, waterPurveyorId, email),
		name,
	);
}

/**
 * Serialises everything that may create a customer on this (purveyor, email)
 * for the rest of the caller's transaction.
 *
 * The unique index used to stop two saves creating the same customer at once;
 * 0024 dropped it, so this does instead. A transaction-scoped advisory lock on
 * the pair: the second save waits, then finds the first one's customer.
 */
export async function lockCustomerEmail(
	executor: Pick<typeof db, "execute">,
	waterPurveyorId: string,
	email: string,
): Promise<void> {
	await executor.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`customer-email:${waterPurveyorId}:${email}`}, 0))`,
	);
}
