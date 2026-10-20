/**
 * How a stored wizard answer reads outside the wizard — on the WP's
 * submitted-test document and the certifier's own submissions list.
 *
 * The wizard stores most answers as booleans, numbers or free text, but two are
 * chosen from a fixed button group and stored as lowercase codes: the initial
 * test's Pass/Fail and the Yes/No/Undetermined of "isolates the entire
 * property". Shown raw, those read as "fail" and "yes" beside a Yes/No select
 * for every boolean — so they get the same labels the wizard's buttons show
 * (`certifier/wizard/test-blocks/choice-buttons.tsx`), and the WP edits them
 * from a dropdown of exactly those choices rather than a text box that would
 * accept any spelling.
 */

/** The coded answers and their labels, in the order the wizard offers them. */
export const WIZARD_CHOICE_ANSWERS: Record<string, Record<string, string>> = {
	initialTestResult: { pass: "Pass", fail: "Fail" },
	isolatesEntireProperty: {
		yes: "Yes",
		no: "No",
		undetermined: "Undetermined",
	},
};

/** The choices a coded answer offers, or null for every other answer. */
export function wizardChoiceOptions(
	key: string,
): Record<string, string> | null {
	return WIZARD_CHOICE_ANSWERS[key] ?? null;
}

/** Abbreviations a key spells in lowercase that read as capitals. */
const ACRONYMS: Record<string, string> = { adp: "ADP" };

/**
 * A `wizard_data` key as a label, every word capitalised.
 *
 * Splits on the boundaries the key already has — camelCase, `_`, `-` and the
 * `.` that groups a check's readings (`bypass.checkValve1ShutTight`) — so
 * every label reads in one consistent style: "Bypass Check Valve1 Shut
 * Tight", "Initial Test Result", "ADP".
 */
export function humanizeFieldName(key: string): string {
	const words = key
		.replace(/[._-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/\s+/)
		.filter(Boolean);

	if (words.length === 0) return key;

	return words
		.map(
			(word) =>
				ACRONYMS[word.toLowerCase()] ??
				word.charAt(0).toUpperCase() + word.slice(1),
		)
		.join(" ");
}

/**
 * A coded answer's label, or null when the answer is not a coded one (or holds
 * a value the wizard never offers, which is then shown as stored).
 */
export function wizardChoiceLabel(key: string, value: unknown): string | null {
	if (typeof value !== "string") return null;

	return wizardChoiceOptions(key)?.[value] ?? null;
}

/**
 * A field's `column` from `wizard-answer-layout` as grid classes. `responsive`
 * for a grid that is two columns only from `sm` up (the WP document) — below
 * that it is one column, where the order alone keeps a reading under its
 * question.
 */
export function answerColumnClass(
	column: "start" | "end" | "full" | undefined,
	responsive = false,
): string | undefined {
	if (!column) return undefined;

	// Spelled out in full rather than built with a template, so Tailwind's
	// scanner finds every class it has to generate.
	const classes = responsive
		? { start: "sm:col-start-1", end: "sm:col-start-2", full: "sm:col-span-2" }
		: { start: "col-start-1", end: "col-start-2", full: "col-span-2" };

	return classes[column];
}
