/**
 * The dynamic values a water purveyor may put in notice text, and the one
 * substitution routine that resolves them.
 *
 * Everything about a variable lives in {@link NOTICE_VARIABLES}: its
 * placeholder, the label the reference panel shows, the sample the preview
 * uses, and — through `scope` — which composers are allowed to use it at all.
 * Adding a seventh variable is an entry in that list plus a value in whatever
 * resolves it. It is deliberately not a change to the editor, the preview or
 * the renderer, none of which name a variable.
 *
 * Pure on purpose: no database import, no tRPC import. The browser renders the
 * preview with the same function the server renders a real send with, so the
 * two cannot disagree about what a placeholder means.
 */

/** Every supported placeholder, by the name that appears between the braces. */
export const NOTICE_VARIABLE_KEYS = [
	"customer_name",
	"wp_name",
	"bfa_type",
	"bin",
	"service_address",
	"due_date",
] as const;

export type NoticeVariableKey = (typeof NOTICE_VARIABLE_KEYS)[number];

/**
 * What a variable is attached to, which is what decides where it may be used.
 *
 * `recipient` values are single-valued for the person being written to — their
 * own name, and the purveyor writing to them. `asset` values belong to one
 * backflow assembly, and a customer may own several: there is no one BIN or
 * one due date for a customer, so an asset variable is meaningful only in a
 * notice that is *about* an assembly.
 */
export type NoticeVariableScope = "recipient" | "asset";

export type NoticeVariable = {
	key: NoticeVariableKey;
	label: string;
	/** What the value is, in the reference panel, in one line. */
	description: string;
	/** Stand-in used by every preview. Recognisably fake, deliberately. */
	sample: string;
	scope: NoticeVariableScope;
};

export const NOTICE_VARIABLES: readonly NoticeVariable[] = [
	{
		key: "customer_name",
		label: "Customer name",
		description: "The customer the message is addressed to",
		sample: "Sample Customer",
		scope: "recipient",
	},
	{
		key: "wp_name",
		label: "Water purveyor name",
		description: "Your organisation's name",
		sample: "Your Water Purveyor",
		scope: "recipient",
	},
	{
		key: "bfa_type",
		label: "BFA type",
		description: "The assembly type — RP, DC, PVB and so on",
		sample: "RP",
		scope: "asset",
	},
	{
		key: "bin",
		label: "BIN",
		description: "The assembly's backflow identification number",
		sample: "BIN-000123",
		scope: "asset",
	},
	{
		key: "service_address",
		label: "Service address",
		description: "Where the assembly is installed",
		sample: "100 Sample Street",
		scope: "asset",
	},
	{
		key: "due_date",
		label: "Due date",
		description: "When the assembly's annual test is due",
		sample: "2026-10-01",
		scope: "asset",
	},
];

/**
 * The variable set each composer offers.
 *
 * Automated notices are written about one assembly, so every variable is
 * available. A general-info broadcast is addressed to a customer, who may own
 * several assemblies — `{{bin}}` there has no single answer, so the asset
 * variables are not offered and, in {@link validateTemplateText}, not accepted.
 */
export const AUTOMATED_NOTICE_VARIABLES = NOTICE_VARIABLES;

export const BROADCAST_VARIABLES = NOTICE_VARIABLES.filter(
	(variable) => variable.scope === "recipient",
);

/** The placeholder as it is typed: `{{customer_name}}`. */
export function placeholderFor(key: NoticeVariableKey | string): string {
	return `{{${key}}}`;
}

export function variableKeys(
	variables: readonly NoticeVariable[],
): NoticeVariableKey[] {
	return variables.map((variable) => variable.key);
}

export type NoticeVariableValues = Partial<
	Record<NoticeVariableKey, string | null | undefined>
>;

/**
 * Matches one placeholder. Surrounding whitespace is tolerated so
 * `{{ customer_name }}` resolves too, which is what somebody who typed it by
 * hand rather than using the insert button will have written.
 *
 * The name character class is deliberately wider than the known keys: an
 * unrecognised placeholder has to be *matched* before it can be reported as
 * unrecognised.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

const KNOWN_KEYS = new Set<string>(NOTICE_VARIABLE_KEYS);

function isKnownKey(key: string): key is NoticeVariableKey {
	return KNOWN_KEYS.has(key);
}

/**
 * Substitutes the allowed placeholders in `template` and leaves every other
 * one exactly as it was written.
 *
 * One pass over the string, not one `replace` per variable. That is what stops
 * a substituted value from being scanned again — a customer whose name
 * genuinely contains `{{due_date}}` gets their name, not a date — and it is
 * why the order of {@link NOTICE_VARIABLES} cannot affect the result.
 *
 * A placeholder that is unknown, not allowed here, or allowed but has no value
 * for this record is returned untouched rather than blanked. Blanking would let
 * a typo disappear into a sentence that still reads; leaving `{{custmer_name}}`
 * visible is what makes the mistake findable in the preview. Nothing ever falls
 * back to another variable's value.
 *
 * The result is plain text. It is never HTML: {@link templateToHtml} is what
 * turns it into a message body, and it escapes.
 */
export function renderTemplate(
	template: string,
	values: NoticeVariableValues,
	allowed: readonly NoticeVariableKey[] = NOTICE_VARIABLE_KEYS,
): string {
	const allowedKeys = new Set<string>(allowed);

	return template.replace(PLACEHOLDER_PATTERN, (match, rawKey: string) => {
		const key = rawKey.toLowerCase();

		if (!isKnownKey(key) || !allowedKeys.has(key)) return match;

		const value = values[key];

		return value === undefined || value === null || value === ""
			? match
			: value;
	});
}

/** Every distinct placeholder name in `template`, in the order first written. */
export function placeholdersIn(template: string): string[] {
	const found: string[] = [];

	for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
		const key = (match[1] ?? "").toLowerCase();
		if (key && !found.includes(key)) found.push(key);
	}

	return found;
}

export type TemplateTextProblem =
	| { kind: "unknown"; placeholder: string }
	| { kind: "not_allowed_here"; placeholder: string };

/**
 * The placeholders in `template` that this composer cannot resolve, split into
 * the two cases that need different sentences: a name no variable has, and a
 * real variable used somewhere it has no single value.
 *
 * Validation, not rendering. The renderer's job is to never invent data; this
 * is what stops text the renderer would leave half-substituted from being
 * saved or sent in the first place.
 */
export function templateTextProblems(
	template: string,
	allowed: readonly NoticeVariableKey[],
): TemplateTextProblem[] {
	const allowedKeys = new Set<string>(allowed);

	return placeholdersIn(template).flatMap<TemplateTextProblem>((key) => {
		if (!isKnownKey(key)) return [{ kind: "unknown", placeholder: key }];
		if (!allowedKeys.has(key))
			return [{ kind: "not_allowed_here", placeholder: key }];
		return [];
	});
}

/**
 * The first problem with `template`, as a sentence, or `null` when there is
 * none. Shared by every Zod schema that validates notice text so the editor and
 * the broadcast composer report the same thing the same way.
 */
export function templateTextError(
	template: string,
	allowed: readonly NoticeVariableKey[],
): string | null {
	const [problem] = templateTextProblems(template, allowed);

	if (!problem) return null;

	const supported = allowed.map(placeholderFor).join(", ");

	return problem.kind === "unknown"
		? `${placeholderFor(problem.placeholder)} is not a supported value. Supported here: ${supported}.`
		: `${placeholderFor(problem.placeholder)} belongs to one assembly, and a customer can have several — it cannot be used here. Supported here: ${supported}.`;
}

/**
 * Sample values for a preview: the registry's stand-ins, with anything real the
 * caller knows written over the top.
 *
 * `{{wp_name}}` is the case that matters — the purveyor's own name is not a
 * guess, so a preview that showed "Your Water Purveyor" where the recipient
 * will read the real name would be a worse preview than it needs to be.
 */
export function sampleVariableValues(
	variables: readonly NoticeVariable[] = NOTICE_VARIABLES,
	overrides: NoticeVariableValues = {},
): Record<NoticeVariableKey, string> {
	const values = {} as Record<NoticeVariableKey, string>;

	for (const variable of variables) {
		const override = overrides[variable.key];
		values[variable.key] = override || variable.sample;
	}

	return values;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Rendered text as the body of an email.
 *
 * Everything is escaped and only line breaks become markup. Notice text is
 * typed by a person into a textarea and substituted with values that came from
 * customer records; treating either as HTML would make a stray `<` a broken
 * message at best, and an injected element at worst. There is no rich-text
 * editor behind this and no markup is interpreted.
 */
export function templateToHtml(text: string): string {
	return escapeHtml(text)
		.split(/\r?\n/)
		.map((line) => (line.trim() === "" ? "<p>&nbsp;</p>" : `<p>${line}</p>`))
		.join("\n");
}
