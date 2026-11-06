import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** One row of `certifiers.listWpCertifiers`, as the server returns it. */
export type WpCertifier =
	RouterOutputs["certifiers"]["listWpCertifiers"][number];

export type CertifierStatus = WpCertifier["status"];

/**
 * Status wording and colour, from the design system's tint pairs. Kept here
 * rather than in the table so the badge and the confirmation dialog cannot
 * label the same row differently.
 */
export const CERTIFIER_STATUS_LABELS: Record<CertifierStatus, string> = {
	active: "Active",
	blocked: "Blocked",
};

export const CERTIFIER_STATUS_VARIANTS = {
	active: "success",
	blocked: "danger",
} as const;

export type CertifierType = WpCertifier["certifierType"];

/**
 * Internal (the purveyor's own staff) or external (a private tester), as the
 * tabs, the invite form and the move action all word it.
 */
export const CERTIFIER_TYPE_LABELS: Record<CertifierType, string> = {
	internal: "Internal",
	external: "External",
};

/**
 * What blocking actually does. Shown wherever a certifier can be blocked, from
 * here, so the table and the confirmation cannot describe it differently.
 *
 * Blocking revokes this purveyor's own authorization of the certifier — it is
 * per purveyor, not account-wide. A certifier holds one account across every
 * purveyor that authorized them, and blocking here ends only this purveyor's
 * relationship: they can no longer pick this purveyor or submit tests to it,
 * and keep signing in for the others.
 *
 * The wording is unconditional — it does not say whether *this* certifier works
 * for anyone else. It could: `wp_certifier_authorizations` has the count. But
 * that count is another tenant's business, and a screen that said "also works
 * for 2 other purveyors" would be leaking the existence of those purveyors
 * across the tenant boundary the rest of this feature is built to hold. Stating
 * the rule is honest and leaks nothing.
 */
export const BLOCK_WARNING =
	"Blocking removes this certifier's access to your water purveyor: they can no longer select it or submit tests to it.";

/**
 * The half of the warning that says what the block does not reach. Split out
 * so the table's confirmation can lead with the effect and follow with the
 * limit.
 */
export const BLOCK_SCOPE_NOTE =
	"If they also work for other water purveyors, that work is unaffected — their account stays active.";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	// The column is a Postgres `date` — a calendar day with no time and no zone.
	// Formatting it in the reader's local zone would move a licence expiring on
	// the 1st to the 31st for anyone west of UTC, so it is read back as UTC.
	timeZone: "UTC",
});

/** A `YYYY-MM-DD` column as a date a person reads. */
export function formatLicenseDate(value: string | null) {
	if (!value) return "—";

	return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

/**
 * Whether a licence expiry has already passed, as of `today`.
 *
 * Compared as calendar strings rather than as `Date`s: both sides are a plain
 * day, and turning them into instants would reintroduce the timezone question
 * the formatter above is careful to avoid. An absent date is not expired — it
 * is unknown, and the column already shows a dash for it.
 */
export function isLicenseExpired(
	value: string | null,
	today: Date = new Date(),
) {
	if (!value) return false;

	return value < today.toISOString().slice(0, 10);
}
