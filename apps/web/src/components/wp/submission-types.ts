import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

/** One row of `submittedTests.listSubmittedTests`, as the server returns it. */
export type Submission =
	RouterOutputs["submittedTests"]["listSubmittedTests"]["rows"][number];

/** The same row from the detail query — deliberately the same shape. */
export type SubmissionDetail =
	RouterOutputs["submittedTests"]["getSubmittedTest"];

/** The correction payload, derived from the router rather than retyped. */
export type SubmissionPayload =
	RouterInputs["submittedTests"]["updateSubmittedTest"];

/** The eight assembly types the server accepts, as a union. */
export type SubmissionBfaType = SubmissionPayload["bfaType"];

/** Pass, fail, or a submitted record that is missing the answer. */
export type SubmissionResult = NonNullable<Submission["testResult"]>;

/** One wizard answer: a scalar or nothing. Never a nested document. */
export type WizardValue = string | number | boolean | null;

/**
 * Result wording and colour, from the design system's status tint pairs. Kept
 * here rather than in the table so the list and the document view cannot label
 * the same test differently.
 */
export const TEST_RESULT_LABELS: Record<SubmissionResult, string> = {
	pass: "Pass",
	fail: "Fail",
};

export const TEST_RESULT_VARIANTS = {
	pass: "success",
	fail: "danger",
} as const;

/** The eight assembly types, in the order the PRD and the wizard list them. */
export const BFA_TYPE_OPTIONS: Record<SubmissionBfaType, string> = {
	RP: "RP",
	RPDA: "RPDA",
	"RPDA-2": "RPDA-2",
	DC: "DC",
	DCDA: "DCDA",
	"DCDA-2": "DCDA-2",
	PVB: "PVB",
	SVB: "SVB",
};

/**
 * How the closing block was signed.
 *
 * "Owner absent" is not a missing signature — it is the certifier's recorded
 * bypass, which stores and prints a mandatory disclaimer (§ 9, "Sign-off"). The
 * wording says so, because "absent" alone reads like an omission.
 */
export const SIGNATURE_METHOD_LABELS = {
	signed: "Signed by the owner or manager",
	owner_absent: "Owner absent — disclaimer applies",
} as const;

/**
 * Which WP roles may correct a submitted test.
 *
 * The screen reads this to decide whether to render edit affordances at all;
 * `wpSubmissionEditorProcedure` is what actually refuses the write. Both exist
 * on purpose — a control that is not offered is not the same thing as a
 * procedure that would refuse it, and only the second is a boundary.
 *
 * The split is § 6.6.6's own decision, taken because correcting a submitted
 * test rewrites the legal record of a backflow test. PRD § 10 leaves the
 * SubAdmin/Employee difference open project-wide; nothing outside this screen
 * inherits this answer.
 */
const SUBMISSION_EDITOR_ROLES = ["wp_admin", "wp_sub_admin"];

export function canEditSubmissions(globalRole: string | undefined): boolean {
	return globalRole ? SUBMISSION_EDITOR_ROLES.includes(globalRole) : false;
}

/** What an Employee is told instead of being shown controls that would fail. */
export const READ_ONLY_NOTE =
	"Your account can read submitted tests. Correcting one, or linking it to an asset, is a WP Admin or SubAdmin action.";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	// `test_date` is a Postgres `date` — a calendar day with no time and no
	// zone. Formatting it in the reader's local zone would move a test performed
	// on the 1st to the 31st for anyone west of UTC, so it is read back as UTC.
	timeZone: "UTC",
});

/** A `YYYY-MM-DD` column as a date a person reads. */
export function formatSubmissionDate(value: string | null): string {
	if (!value) return "—";

	return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

/**
 * Which BIN to show for a submission, and whether it is a real one.
 *
 * Three states, not two. A submission resolved to an asset shows that asset's
 * BIN. One that never resolved shows what the certifier typed, which is a
 * record of their best guess rather than an identifier — so it is marked
 * unresolved, because a reader who cannot tell them apart cannot tell which
 * rows still need work. A submission with neither shows that it has nothing,
 * which is the loudest version of the same problem.
 */
export function binLabel(submission: {
	bin: string | null;
	submittedBinText: string | null;
}): { text: string; resolved: boolean } {
	if (submission.bin) return { text: submission.bin, resolved: true };

	return {
		text: submission.submittedBinText || "No BIN given",
		resolved: false,
	};
}

/**
 * A `wizard_data` key as a label.
 *
 * The per-BFA-type field set is the wizard's to define (§ 6.5, week 4), so this
 * screen cannot carry a label table for fields that do not exist yet — and
 * inventing one now would mean inventing it twice, then reconciling. Splitting
 * `camelCase` and `snake_case` on the boundaries the key already has is the
 * honest middle: it reads as English for every key a JavaScript or Postgres
 * codebase produces, and it does not pretend to know what the key means.
 *
 * When the wizard lands with a real per-type field reference, this is the one
 * function that gets replaced by a lookup.
 */
export function humanizeFieldName(key: string): string {
	const spaced = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim();

	if (!spaced) return key;

	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The wizard answers in a stable order.
 *
 * Sorted by key rather than left in insertion order, because `jsonb` does not
 * preserve insertion order — Postgres returns the keys in its own — so a
 * document that trusted it would reshuffle its own fields between saves. Sorted
 * is not the wizard's order and does not pretend to be; it is an order that
 * holds still, which is what a reader comparing two prints of the same test
 * needs until the per-type field reference exists to supply the real one.
 */
export function wizardEntries(
	wizardData: unknown,
): [key: string, value: WizardValue][] {
	if (typeof wizardData !== "object" || wizardData === null) return [];

	return Object.entries(wizardData as Record<string, unknown>)
		.filter((entry): entry is [string, WizardValue] => isWizardValue(entry[1]))
		.sort(([left], [right]) => left.localeCompare(right));
}

function isWizardValue(value: unknown): value is WizardValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

/**
 * A wizard answer as the text an input shows.
 *
 * Booleans deliberately do not come through here — they get a Yes/No control of
 * their own, because a checkbox rendered as the word "true" is a value somebody
 * will eventually type "True" into.
 */
export function wizardValueText(value: WizardValue): string {
	if (value === null) return "";

	return String(value);
}

/**
 * Typed text back into a wizard answer, keeping the answer's own type.
 *
 * A field that held a number keeps holding one, so a reading corrected from
 * `8.2` to `8.4` does not quietly become the string `"8.4"` and change how
 * every later comparison of it behaves. Text that no longer parses as a number
 * is kept as text rather than refused — the reader is mid-correction, and the
 * server's own shape accepts either.
 */
export function parseWizardValue(
	previous: WizardValue,
	text: string,
): WizardValue {
	if (text === "") return null;

	if (typeof previous === "number") {
		const parsed = Number(text);
		return Number.isFinite(parsed) ? parsed : text;
	}

	return text;
}
