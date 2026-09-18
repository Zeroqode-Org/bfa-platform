import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** One row of `certifier.listDrafts` / `certifier.listSubmissions`. */
export type CertifierSubmissionRow =
	RouterOutputs["certifier"]["listDrafts"]["rows"][number];

/** The full record `certifier.getDraft` returns. */
export type CertifierDraft = RouterOutputs["certifier"]["getDraft"];

/** Pass, fail, or a submitted record still missing the answer. */
type SubmissionResult = NonNullable<CertifierSubmissionRow["testResult"]>;

/**
 * Result wording and colour. Kept local to the certifier screens rather than
 * imported from `@/components/wp/submission-types` — the two routers are
 * decoupled on purpose, and a shared constants module would be the one thing
 * quietly re-coupling them.
 */
export const TEST_RESULT_LABELS: Record<SubmissionResult, string> = {
	pass: "Pass",
	fail: "Fail",
};

export const TEST_RESULT_VARIANTS = {
	pass: "success",
	fail: "danger",
} as const;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	// `test_date` is a Postgres `date` — a calendar day with no time or zone.
	// Reading it back in UTC keeps a test performed on the 1st from becoming
	// the 31st for anyone west of it.
	timeZone: "UTC",
});

/** A `YYYY-MM-DD` column as a date a person reads. */
export function formatTestDate(value: string | null): string {
	if (!value) return "—";
	return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

/** A `timestamptz` column as "last saved" text. */
export function formatSavedAt(value: string | Date): string {
	return dateTimeFormatter.format(new Date(value));
}

/**
 * Which BIN to show, and whether it is a real one. Same three-state
 * reasoning as `binLabel` in `wp/submission-types.ts`: a resolved asset's
 * BIN, or what the certifier typed, or nothing at all — and a reader has to
 * be able to tell the three apart.
 */
export function binLabel(row: {
	bin: string | null;
	submittedBinText: string | null;
}): { text: string; resolved: boolean } {
	if (row.bin) return { text: row.bin, resolved: true };
	return { text: row.submittedBinText || "No BIN given", resolved: false };
}

type WizardValue = string | number | boolean | null;

/**
 * The wizard answers in a stable order, generically — the per-BFA-type field
 * set is the wizard's own to define (§ 6.5) and does not exist yet, so this
 * reads whatever keys `wizard_data` actually carries rather than assuming the
 * prototype's hardcoded field list. Sorted rather than left in insertion
 * order, since `jsonb` does not preserve one.
 */
export function wizardEntries(
	wizardData: unknown,
): [key: string, value: WizardValue][] {
	if (typeof wizardData !== "object" || wizardData === null) return [];

	return Object.entries(wizardData as Record<string, unknown>)
		.filter(
			(entry): entry is [string, WizardValue] =>
				entry[1] === null ||
				typeof entry[1] === "string" ||
				typeof entry[1] === "number" ||
				typeof entry[1] === "boolean",
		)
		.sort(([left], [right]) => left.localeCompare(right));
}

/** A `wizard_data` key as a label — see `wizardEntries` for why it is generic. */
export function humanizeFieldName(key: string): string {
	const spaced = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim();

	if (!spaced) return key;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A wizard answer as display text. Booleans read as Yes/No, not "true". */
export function wizardValueText(value: WizardValue): string {
	if (value === null) return "—";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return String(value);
}
