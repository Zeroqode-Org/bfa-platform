import {
	ADP_KEY,
	ASSEMBLY_FIELD_KEYS,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	LINE_PRESSURE_KEY,
	PHOTO_PATH_KEYS,
	SIGN_OFF_DISCLAIMER_KEY,
	type ValveAnswerTerms,
	valveYesWithReading,
	WATER_METER_END_KEY,
	WATER_METER_END_LABEL,
	WATER_METER_START_KEY,
	WATER_METER_START_LABEL,
	WIZARD_TEST_SPEC,
	type WizardQuestion,
} from "./wizard-input";

/**
 * The order and labels a submitted test's answers are listed in on screen —
 * the WP's submitted-test document and the certifier's own submissions list —
 * matching the results PDF section by section (client, October 2026):
 *
 * assembly → customer → line pressure, ADP, water meter start/end → the type's
 * valve questions in `WIZARD_TEST_SPEC` order, each reading straight after its
 * Yes/No → property isolation → initial test result → comment → sign-off →
 * photos.
 *
 * Labels come from the spec the wizard and the PDF already read, so a valve
 * row is called by the part it tests ("Check Valve 1"), its answer is worded
 * in the client's terms ("Tight" / "Leak") and its reading is labelled as the
 * wizard asks for it ("Check Valve 1 reading"). Pure, no DB import, so the
 * browser can use it.
 */

export type WizardAnswerKind =
	/** A Yes/No question, stored as a boolean. */
	| "yes_no"
	/** A valve's PSID reading — shown with one decimal place. */
	| "psid"
	/** A stored photo path — shown as the photo, never as the path. */
	| "photo"
	/** Anything else: text, a number, or a coded choice. */
	| "value";

/**
 * Where a field sits in the two-column grid, so a row means something:
 *
 * - `start` — begins a new row, in the left column;
 * - `end` — the right column of the row its partner started;
 * - `full` — a row of its own, both columns (long text);
 * - absent — flows into the next free cell.
 *
 * A valve question is `start` and its PSID `end`, so a question with no
 * reading (Check Valve 2 on an RP line, or any "No") leaves its right cell
 * empty instead of pulling the next question up beside it.
 */
export type WizardAnswerColumn = "start" | "end" | "full";

export type WizardAnswerField = {
	key: string;
	label: string;
	kind: WizardAnswerKind;
	column?: WizardAnswerColumn;
	/** A `yes_no` field's words for `true` and `false` — "Tight" / "Leak". */
	answers?: ValveAnswerTerms;
};

type BfaType = keyof typeof WIZARD_TEST_SPEC;

const ASSEMBLY_FIELDS: WizardAnswerField[] = [
	field(ASSEMBLY_FIELD_KEYS.serviceAddress, "Service Address"),
	field(ASSEMBLY_FIELD_KEYS.make, "Make"),
	field(ASSEMBLY_FIELD_KEYS.model, "Model"),
	field(ASSEMBLY_FIELD_KEYS.serialNumber, "Serial Number"),
	field(ASSEMBLY_FIELD_KEYS.size, "Size"),
	field(ASSEMBLY_FIELD_KEYS.location, "Assembly Location"),
	field(CUSTOMER_NAME_KEY, "Customer Name", "start"),
	field(CUSTOMER_EMAIL_KEY, "Customer Email", "end"),
];

const CLOSING_FIELDS: WizardAnswerField[] = [
	field(ISOLATES_PROPERTY_KEY, "Isolates Entire Property", "start"),
	field(INITIAL_TEST_KEY, "Initial Test Result", "end"),
	field("comments", "Comments", "full"),
	field(SIGN_OFF_DISCLAIMER_KEY, "Sign Off Disclaimer", "full"),
	...PHOTO_PATH_KEYS.map(
		(key, index): WizardAnswerField => ({
			key,
			label: `Photo ${index + 1}`,
			kind: "photo",
		}),
	),
];

/**
 * Every field one BFA type's test can carry, in display order. Includes fields
 * the type does not ask (ADP on a DC) only when they are in the spec — the
 * caller drops the ones a given test has no answer for.
 */
export function wizardAnswerFields(bfaType: BfaType): WizardAnswerField[] {
	const spec = WIZARD_TEST_SPEC[bfaType];
	const fields: WizardAnswerField[] = [
		...ASSEMBLY_FIELDS,
		field(LINE_PRESSURE_KEY, "Line Pressure", "start"),
	];

	if (spec.hasAdp) fields.push(field(ADP_KEY, "ADP", "end"));

	if (spec.hasMeter) {
		fields.push(
			field(WATER_METER_START_KEY, WATER_METER_START_LABEL, "start"),
			field(WATER_METER_END_KEY, WATER_METER_END_LABEL, "end"),
		);
	}

	for (const section of spec.sections) {
		for (const question of section.questions) {
			const label = questionLabel(question.key, question.label);

			fields.push({
				key: question.key,
				label,
				kind: "yes_no",
				column: "start",
				answers: question.answers,
			});

			if (question.valueKey) {
				fields.push({
					key: question.valueKey,
					label: questionLabel(
						question.key,
						question.valueLabel ?? `${question.label} reading`,
					),
					kind: "psid",
					column: "end",
				});
			}
		}
	}

	return [...fields, ...CLOSING_FIELDS];
}

/**
 * A test's stored answers in display order, each with its label.
 *
 * Only keys the test actually holds are listed. A key the layout does not know
 * — an answer left from another BFA type, or a field added to the wizard later
 * — is not dropped: it follows the known ones, A–Z, labelled by `fallbackLabel`,
 * so nothing a certifier recorded silently disappears from the screen.
 */
export function orderedWizardAnswers<Value>(
	bfaType: BfaType,
	entries: [key: string, value: Value][],
	fallbackLabel: (key: string) => string,
): (WizardAnswerField & { value: Value })[] {
	const byKey = new Map(entries);
	const known = wizardAnswerFields(bfaType);
	const knownKeys = new Set(known.map((entry) => entry.key));

	const listed = known
		.filter((entry) => byKey.has(entry.key))
		.map((entry) => ({ ...entry, value: byKey.get(entry.key) as Value }));

	const extra = entries
		.filter(([key]) => !knownKeys.has(key))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => ({
			key,
			label: fallbackLabel(key),
			kind: "value" as const,
			value,
		}));

	return [...listed, ...extra];
}

/**
 * A PSID reading with at least one decimal place (client, October 2026):
 * `2` → "2.0". Display only — the stored value is not changed. A reading
 * typed with more places keeps them ("3.25" stays "3.25") rather than being
 * rounded, and text that is not a number is returned unchanged rather than
 * lost.
 */
export function formatPsid(value: unknown): string {
	if (value === null || value === undefined || value === "") return "";

	const text = String(value).trim();

	if (!/^-?\d+(\.\d+)?$/.test(text)) return text;

	const [, decimals = ""] = text.split(".");

	return decimals.length >= 1 ? text : Number(text).toFixed(1);
}

/**
 * A valve's two answers as they are printed beside it: the chosen `yes`
 * carries its reading ("Opened at 2.0 PSID"), the other term stands alone.
 * One place for the PDF, the certifier's document and the WP's, so the three
 * cannot word the same answer differently.
 */
export function valveAnswerLabels(
	entry: WizardQuestion,
	wizardData: Record<string, unknown>,
): { answer: unknown; yes: string; no: string } {
	const answer = wizardData[entry.key];
	const reading =
		entry.valueKey && answer === true
			? formatPsid(wizardData[entry.valueKey]) || null
			: null;

	return {
		answer,
		yes:
			answer === true ? valveYesWithReading(entry, reading) : entry.answers.yes,
		no: entry.answers.no,
	};
}

function field(
	key: string,
	label: string,
	column?: WizardAnswerColumn,
): WizardAnswerField {
	return column
		? { key, label, kind: "value", column }
		: { key, label, kind: "value" };
}

/**
 * The spec's part name as a field label, with the main line of a two-line
 * assembly named as such — the spec leaves "Main" off because the PDF shows it
 * under its section heading, which a flat list does not have.
 */
function questionLabel(key: string, label: string): string {
	return key.startsWith("main.") ? `Main ${label}` : label;
}
