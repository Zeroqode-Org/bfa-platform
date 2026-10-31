import { z } from "zod";

import { ASSET_FIELD_LIMITS } from "./asset-field-limits";
import {
	isOwnPhotoPath,
	MAX_PHOTO_BYTES,
	MAX_PHOTOS,
	PHOTO_CONTENT_TYPES,
	PHOTO_EXTENSIONS,
	PHOTO_FORMATS,
	PHOTO_REJECTION_MESSAGES,
} from "./photo-rules";
import { SUBMISSION_FIELD_LIMITS } from "./submission-field-limits";
import {
	BFA_TYPES,
	SIGNATURE_METHODS,
	type TEST_RESULTS,
	wizardDataInput,
} from "./submission-input";

/**
 * Input shapes for the certifier wizard's own procedures (§ 6.5).
 *
 * Pure logic, no DB import — same reason `submission-input.ts` and
 * `asset-input.ts` give: `routers/certifier-wizard.ts` imports
 * `@bfa-platform/db`, and importing that to assert a draft save skips
 * validation would make a pure rule need a Postgres.
 *
 * `BFA_TYPES`, `wizardDataInput` and `SIGNATURE_METHODS` are reused from
 * `submission-input.ts` rather than redeclared — the wizard and the WP's
 * correction form write the same columns, and a second copy of "the eight
 * types" would be a second place for a ninth to be added to only one of them.
 */

/** The exact disclaimer text the checkbox bypass stamps onto the record (build-plan § 6.5 step 19). It must appear verbatim on the generated document. */
export const OWNER_ABSENT_DISCLAIMER =
	"Owner was not present - I certify under penalty of law and regulatory compliance guidelines that the assembly test values recorded above are true and accurate. The property manager was not present to sign the physical digital screen at the time of service.";

/** The wizard's own `wizard_data` key the disclaimer text is stored under, alongside the certifier's answers. */
export const SIGN_OFF_DISCLAIMER_KEY = "signOffDisclaimer";

/** The trailing field every one of the eight types ends its test block with. */
export const ISOLATES_PROPERTY_KEY = "isolatesEntireProperty";
export const ISOLATES_PROPERTY_VALUES = ["yes", "no", "undetermined"] as const;

/** Only the RP family takes ADP; the DC family and PVB/SVB take Line Pressure alone. */
export const ADP_TYPES = ["RP", "RPDA", "RPDA-2"] as const;

/**
 * The closing-block photos are at most two, and `wizard_data` holds scalars
 * only, so each uploaded photo's storage path is kept under its own key.
 */
export const PHOTO_PATH_KEYS = ["photo1Path", "photo2Path"] as const;

export const ADP_KEY = "adp";
export const WATER_METER_START_KEY = "waterMeterStart";
export const WATER_METER_END_KEY = "waterMeterEnd";
/** The one Pass/Fail answer per test — it is also the submission's overall result. */
export const INITIAL_TEST_KEY = "initialTestResult";
export const LINE_PRESSURE_KEY = "linePressure";

/**
 * Customer name/email have no dedicated columns — `test_submissions` was
 * fixed before this plan and is not being redesigned to add them — so, like
 * every other wizard answer, they are written into `wizard_data` under these
 * two fixed keys. Reused by `submitTest` (writes them), the results-document
 * renderer and the distribution helper (both read them), and the WP's
 * generic answers list in `submission-document.tsx` (which will simply show
 * them as two more rows, exactly as any other wizard field).
 */
export const CUSTOMER_NAME_KEY = "customerName";
export const CUSTOMER_EMAIL_KEY = "customerEmail";

/**
 * The assembly-details fields (build-plan § 6.5 step 10) have the same
 * problem customer name/email do: `test_submissions` carries no columns for
 * them, and the no-BIN flow has no `bfa_assets` row to read them from at
 * all. So, whether they arrived by prefill or by the certifier typing them
 * in directly, they are written into `wizard_data` under these fixed keys —
 * which is also what lets the results document show the assembly a no-BIN
 * test was actually run against, rather than a block of dashes.
 */
export const ASSEMBLY_FIELD_KEYS = {
	serviceAddress: "assemblyServiceAddress",
	make: "assemblyMake",
	model: "assemblyModel",
	serialNumber: "assemblySerialNumber",
	size: "assemblySize",
	location: "assemblyLocationText",
} as const;

/**
 * Optional free text. A field typed into and cleared arrives as `""`, not
 * `undefined` — collapsing it to `null` here is what makes clearing a field
 * mean clearing it, the same reasoning `asset-input.ts`'s `optionalText` gives.
 */
function optionalText(max: number) {
	return z
		.string()
		.trim()
		.max(max)
		.nullish()
		.transform((value) => value || null);
}

/**
 * A draft step's save. Deliberately loose: build-plan § 6.5 step 1 is explicit
 * that a draft save skips required-field validation entirely — a half-filled
 * step must save exactly as typed, so this input caps size and shape only,
 * never presence.
 *
 * `id` absent means "create" — the wizard's first save of a fresh test.
 * `bfaType` is required even on create because the schema's `bfa_type` column
 * is `NOT NULL`; the wizard always knows which type it is running before its
 * first save (the identification step sets it, defaulting to `RP` only for
 * the brief window before a BIN or a manual type choice resolves it).
 */
export const saveDraftStepInput = z.object({
	id: z.uuid().optional(),
	waterPurveyorId: z.uuid(),
	bfaType: z.enum(BFA_TYPES),
	currentStep: z.number().int().min(1),
	wizardData: wizardDataInput,
	submittedBinText: optionalText(SUBMISSION_FIELD_LIMITS.submittedBinText),
	bfaAssetId: z
		.uuid()
		.nullish()
		.transform((value) => value ?? null),
	// The rest of the closing block. A draft carries them so that resuming
	// finds the date and sign-off where they were left; blank means not yet
	// given, and nothing here is validated (draft saves never are).
	testDate: z
		.union([z.iso.date(), z.literal(""), z.null()])
		.nullish()
		.transform((value) => value || null),
	signatureMethod: z
		.enum(SIGNATURE_METHODS)
		.nullish()
		.transform((value) => value ?? null),
	signatureData: optionalText(SUBMISSION_FIELD_LIMITS.signatureData),
	overriddenFields: z
		.array(z.string().max(SUBMISSION_FIELD_LIMITS.wizardKeyLength))
		.max(SUBMISSION_FIELD_LIMITS.wizardKeys)
		.optional(),
});

export const lookupBinInput = z.object({
	waterPurveyorId: z.uuid(),
	bin: z.string().trim().min(1).max(ASSET_FIELD_LIMITS.bin),
});

/** How many BIN suggestions the identification step's dropdown shows at most. */
export const BIN_SUGGESTION_LIMIT = 8;

export const searchBinsInput = z.object({
	waterPurveyorId: z.uuid(),
	query: z.string().trim().min(1).max(ASSET_FIELD_LIMITS.bin),
});

export const photoUrlsInput = z.object({
	id: z.uuid(),
	waterPurveyorId: z.uuid(),
	paths: z.array(z.string().max(500)).max(MAX_PHOTOS),
});

/** One of the caller's own tests, under the purveyor it was filed with. */
export const testRefInput = z.object({
	id: z.uuid(),
	waterPurveyorId: z.uuid(),
});

/**
 * What the browser tells the server about a photo before it may upload one —
 * already normalised by `checkPhotoFile`: canonical extension, its matching
 * MIME type, and a size within the limit. A claim, not proof of the bytes
 * (see `photo-rules.ts`); it only picks the key's extension and the content
 * type, and is refused outright when it is anything but an allowlisted pair.
 */
export const getPhotoUploadUrlInput = testRefInput
	.extend({
		extension: z.enum(PHOTO_EXTENSIONS),
		contentType: z.enum(PHOTO_CONTENT_TYPES),
		size: z.number().int().min(1).max(MAX_PHOTO_BYTES),
		// The photos the form currently shows; everything else in the draft's
		// folder may be pruned before the new key is chosen.
		keep: z.array(z.string().max(500)).max(MAX_PHOTOS).default([]),
	})
	.refine((input) => PHOTO_FORMATS[input.extension] === input.contentType, {
		message: PHOTO_REJECTION_MESSAGES.format,
		path: ["contentType"],
	});

/**
 * The submit-time shape. Everything a draft may leave blank is required here
 * — this is the boundary build-plan step 20 calls "validates all required
 * fields and test results", checked once, in this one function, rather than
 * re-derived per caller.
 */
export const submitTestInput = z.object({
	id: z.uuid(),
	waterPurveyorId: z.uuid(),
	bfaType: z.enum(BFA_TYPES),
	wizardData: wizardDataInput,
	customerName: z.string().trim().max(200),
	customerEmail: z
		.string()
		.trim()
		.max(320)
		.refine((value) => value === "" || z.email().safeParse(value).success),
	testDate: z.iso.date(),
	signatureMethod: z.enum(SIGNATURE_METHODS),
	// Required exactly when signed; the owner-absent path stores the mandatory
	// disclaimer text instead, written server-side in `signOffPayload` below —
	// never trusted from the client, so the exact wording cannot be tampered
	// with in transit.
	signatureData: optionalText(SUBMISSION_FIELD_LIMITS.signatureData),
	photoPaths: z.array(z.string().max(500)).max(MAX_PHOTOS).default([]),
	/**
	 * The prefilled answers the certifier typed over, as the form holds them at
	 * submit — the last draft save may predate an edit on the final screens.
	 * Stored on the test, and what `submitTest` carries onto the asset.
	 */
	overriddenFields: z
		.array(z.string().max(SUBMISSION_FIELD_LIMITS.wizardKeyLength))
		.max(SUBMISSION_FIELD_LIMITS.wizardKeys)
		.optional(),
});

export type SaveDraftStepInput = z.infer<typeof saveDraftStepInput>;
export type LookupBinInput = z.infer<typeof lookupBinInput>;
export type SubmitTestInput = z.infer<typeof submitTestInput>;

/**
 * A size as a plain decimal number, from however it was written:
 * "1 inch" → "1", "3/4 in" → "0.75", "1 1/2" → "1.5". Text with no number in
 * it comes back unchanged rather than being lost.
 */
export function parseSize(text: string | null | undefined): string {
	const raw = (text ?? "").trim();
	const mixed = raw.match(/^(\d+)\s+(\d+)\/(\d+)/);
	const fraction = raw.match(/^(\d+)\/(\d+)/);
	const decimal = raw.match(/^\d*\.?\d+/);

	if (mixed?.[1] && mixed[2] && mixed[3] && Number(mixed[3]) !== 0) {
		return String(Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]));
	}
	if (fraction?.[1] && fraction[2] && Number(fraction[2]) !== 0) {
		return String(Number(fraction[1]) / Number(fraction[2]));
	}

	return decimal ? decimal[0] : raw;
}

/**
 * The two answers a valve question offers, in the client's terminology sheet
 * ("USE ONLY THESE TERMS", October 2026): "Tight" / "Leak" for a check valve,
 * "Opened at" / "Did not open" for a relief valve or air inlet, and so on.
 * Stored as a boolean all the same — `yes` is `true` — so the words can change
 * without touching a single saved test.
 */
export type ValveAnswerTerms = { yes: string; no: string };

export const TIGHT_OR_LEAK: ValveAnswerTerms = { yes: "Tight", no: "Leak" };
export const OPENED_OR_NOT: ValveAnswerTerms = {
	yes: "Opened at",
	no: "Did not open",
};
export const FULLY_OPENED_OR_NOT: ValveAnswerTerms = {
	yes: "Fully opened",
	no: "Did not fully open",
};

export type WizardQuestion = {
	/** `wizard_data` key of the answer, a boolean: `true` is `answers.yes`. */
	key: string;
	/** The part being tested, as the terminology sheet names it: "Check Valve 1". */
	label: string;
	/** The words for the two answers — see {@link ValveAnswerTerms}. */
	answers: ValveAnswerTerms;
	/** Present when the `yes` answer asks for a reading ("If Yes → Value"). */
	valueKey?: string;
	/** What that reading is, as its field label: "Check Valve 1 reading". */
	valueLabel?: string;
	/**
	 * Words before the reading where the answer does not already lead into it:
	 * "Check held at" on a vacuum breaker's check valve. "Opened at" needs none.
	 */
	readingLabel?: string;
};

export type WizardSection = {
	/** Heading such as "DA TEST 2 — BYPASS ASSEMBLY"; null for an untitled block. */
	title: string | null;
	questions: WizardQuestion[];
};

export type WizardTestSpec = {
	hasAdp: boolean;
	/** Water Meter Start before the tests and End after them (detector types only). */
	hasMeter: boolean;
	sections: WizardSection[];
};

/** Pressure readings are entered in these units, shown inside the input. */
export const LINE_PRESSURE_UNIT = "PSI";
export const PRESSURE_DIFFERENCE_UNIT = "PSID";

/** The water meter pair, worded as the terminology sheet has it. */
export const WATER_METER_START_LABEL = "Water meter start reading";
export const WATER_METER_END_LABEL = "Water meter stop reading";

/**
 * The word for a stored answer — "Tight", "Did not open" — or null when the
 * question has not been answered.
 */
export function valveAnswerTerm(
	entry: WizardQuestion,
	answer: unknown,
): string | null {
	if (answer === true) return entry.answers.yes;
	if (answer === false) return entry.answers.no;

	return null;
}

/**
 * The `yes` answer with its reading, as one phrase: "Opened at 2.0 PSID",
 * "Tight — 2.0 PSID", "Tight — Check held at 2.0 PSID". `reading` is the
 * already-formatted number; without one the plain term is returned.
 */
export function valveYesWithReading(
	entry: WizardQuestion,
	reading: string | null,
): string {
	if (!reading) return entry.answers.yes;

	const value = `${reading} ${PRESSURE_DIFFERENCE_UNIT}`;

	// A term that already ends in "at" leads straight into the number.
	if (/ at$/.test(entry.answers.yes)) return `${entry.answers.yes} ${value}`;

	return `${entry.answers.yes} — ${entry.readingLabel ? `${entry.readingLabel} ` : ""}${value}`;
}

function checkValve(
	key: string,
	label: string,
	valueKey?: string,
	readingLabel?: string,
): WizardQuestion {
	return {
		key,
		label,
		answers: TIGHT_OR_LEAK,
		...(valueKey
			? {
					valueKey,
					valueLabel: readingLabel ?? `${label} reading`,
					readingLabel,
				}
			: {}),
	};
}

function openedAt(
	key: string,
	label: string,
	valueKey: string,
): WizardQuestion {
	return {
		key,
		label,
		answers: OPENED_OR_NOT,
		valueKey,
		valueLabel: `${label} opened at`,
	};
}

/** A reduced-pressure line: relief valve, then check valve 2, then 1. */
function rpLine(prefix: string, labelPrefix = ""): WizardQuestion[] {
	return [
		openedAt(
			`${prefix}reliefValveOpened`,
			`${labelPrefix}Differential Relief Valve`,
			`${prefix}reliefValveValue`,
		),
		checkValve(`${prefix}checkValve2ShutTight`, `${labelPrefix}Check Valve 2`),
		checkValve(
			`${prefix}checkValve1ShutTight`,
			`${labelPrefix}Check Valve 1`,
			`${prefix}checkValve1Value`,
		),
	];
}

/** A double-check line: check valve 1 then 2, each with its own reading. */
function dcLine(prefix: string, labelPrefix = ""): WizardQuestion[] {
	return [
		checkValve(
			`${prefix}checkValve1ShutTight`,
			`${labelPrefix}Check Valve 1`,
			`${prefix}checkValve1Value`,
		),
		checkValve(
			`${prefix}checkValve2ShutTight`,
			`${labelPrefix}Check Valve 2`,
			`${prefix}checkValve2Value`,
		),
	];
}

const airInletOpened = openedAt(
	"airInletValveOpened",
	"Air Inlet",
	"airInletValveValue",
);

const airInletFullyOpened: WizardQuestion = {
	key: "airInletValveFullyOpened",
	// Same part as the question before it, so the label says which check this is.
	label: "Air Inlet (full opening)",
	answers: FULLY_OPENED_OR_NOT,
};

const vacuumBreakerCheckValve = checkValve(
	"checkValveShutTight",
	"Check Valve",
	"checkValveValue",
	"Check held at",
);

/**
 * The test block of every BFA type, transcribed from the client's "Wizard data
 * collection" sheet. The single source for what is asked, in what order and
 * under which heading: validation below, the on-screen step and the results
 * PDF all read it, so they cannot drift apart. Keep it in step with the sheet.
 */
export const WIZARD_TEST_SPEC: Record<
	(typeof BFA_TYPES)[number],
	WizardTestSpec
> = {
	RP: {
		hasAdp: true,
		hasMeter: false,
		sections: [{ title: null, questions: rpLine("") }],
	},
	RPDA: {
		hasAdp: true,
		hasMeter: true,
		sections: [
			{ title: "RP TEST 1", questions: rpLine("main.") },
			{
				title: "DA TEST 2 — BYPASS ASSEMBLY",
				questions: rpLine("bypass.", "Bypass "),
			},
		],
	},
	"RPDA-2": {
		hasAdp: true,
		hasMeter: true,
		sections: [
			{ title: "RP TEST 1", questions: rpLine("main.") },
			{
				title: "DA TEST 2 — BYPASS ASSEMBLY",
				questions: [
					checkValve(
						"bypass.checkValve1ShutTight",
						"Bypass Check Valve",
						"bypass.checkValve1Value",
					),
				],
			},
		],
	},
	DC: {
		hasAdp: false,
		hasMeter: false,
		sections: [{ title: null, questions: dcLine("") }],
	},
	DCDA: {
		hasAdp: false,
		hasMeter: true,
		sections: [
			{
				title: "DA TEST 1 — BYPASS ASSEMBLY",
				questions: dcLine("bypass.", "Bypass "),
			},
			{ title: "DC TEST 2 — MAIN ASSEMBLY", questions: dcLine("main.") },
		],
	},
	"DCDA-2": {
		hasAdp: false,
		hasMeter: true,
		sections: [
			{
				title: "DA TEST 1 — BYPASS ASSEMBLY",
				questions: [
					checkValve(
						"bypass.checkValve1ShutTight",
						"Bypass Check Valve",
						"bypass.checkValve1Value",
					),
				],
			},
			{ title: "DC TEST 2 — MAIN ASSEMBLY", questions: dcLine("main.") },
		],
	},
	// The same three questions, in each type's own order from the sheet: a
	// pressure vacuum breaker tests the air inlet first, a spill-resistant one
	// its check valve first.
	PVB: {
		hasAdp: false,
		hasMeter: false,
		sections: [
			{
				title: null,
				questions: [
					airInletOpened,
					airInletFullyOpened,
					vacuumBreakerCheckValve,
				],
			},
		],
	},
	SVB: {
		hasAdp: false,
		hasMeter: false,
		sections: [
			{
				title: null,
				questions: [
					vacuumBreakerCheckValve,
					airInletOpened,
					airInletFullyOpened,
				],
			},
		],
	},
};

/** Every question of a type's test block, across its sections. */
export function wizardQuestionsFor(
	bfaType: (typeof BFA_TYPES)[number],
): WizardQuestion[] {
	return WIZARD_TEST_SPEC[bfaType].sections.flatMap(
		(section) => section.questions,
	);
}

/**
 * The `wizard_data` keys a type always requires — each Yes/No question, the
 * water meter pair where the type has one, the Initial Test and the
 * isolates-the-property answer. A question's value key is conditional on a Yes
 * and is checked by `missingWizardFields`, not listed here.
 */
export function wizardRequiredFieldsFor(
	bfaType: (typeof BFA_TYPES)[number],
): string[] {
	const spec = WIZARD_TEST_SPEC[bfaType];

	return [
		...(spec.hasMeter ? [WATER_METER_START_KEY, WATER_METER_END_KEY] : []),
		...wizardQuestionsFor(bfaType).map((entry) => entry.key),
		INITIAL_TEST_KEY,
		ISOLATES_PROPERTY_KEY,
	];
}

function isBlank(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

/**
 * The submission's overall `test_result`: the Initial Test answer itself. The
 * sheet asks for exactly one Pass/Fail per test, after the last valve reading,
 * so there is nothing to derive — but it is read here, on the server, and never
 * taken from the client as a separate field. Only called from `submitTest`,
 * after `missingWizardFields` has confirmed the answer is present.
 */
export function deriveTestResult(
	wizardData: Record<string, unknown>,
): (typeof TEST_RESULTS)[number] {
	return wizardData[INITIAL_TEST_KEY] === "fail" ? "fail" : "pass";
}

/**
 * The assembly details are not optional in the sheet — each is either "Auto
 * filled" or "Certifier input" — so all six must be present, prefilled or typed.
 */
export function missingAssemblyFields(
	wizardData: Record<string, unknown>,
): string[] {
	return Object.values(ASSEMBLY_FIELD_KEYS).filter((key) =>
		isBlank(wizardData[key]),
	);
}

/**
 * The test-block keys `wizardData` lacks for `bfaType`. A blank counts as
 * missing, a value is required only when its question was answered Yes, and
 * the Initial Test must be exactly pass or fail.
 */
export function missingTestFields(
	bfaType: (typeof BFA_TYPES)[number],
	wizardData: Record<string, unknown>,
): string[] {
	const missing: string[] = [];

	for (const key of wizardRequiredFieldsFor(bfaType)) {
		const value = wizardData[key];
		const invalid =
			key === INITIAL_TEST_KEY
				? value !== "pass" && value !== "fail"
				: isBlank(value);

		if (invalid) missing.push(key);
	}

	for (const entry of wizardQuestionsFor(bfaType)) {
		if (
			entry.valueKey &&
			wizardData[entry.key] === true &&
			isBlank(wizardData[entry.valueKey])
		) {
			missing.push(entry.valueKey);
		}
	}

	return missing;
}

/**
 * Everything the wizard data must carry to be submitted: the assembly details
 * and the test block. Used only by `submitTest`; a draft save never calls
 * this. Customer, date and sign-off are separate inputs and are checked by
 * `submitTestInput` itself.
 */
export function missingWizardFields(
	bfaType: (typeof BFA_TYPES)[number],
	wizardData: Record<string, unknown>,
): string[] {
	return [
		...missingAssemblyFields(wizardData),
		...missingTestFields(bfaType, wizardData),
	];
}

/**
 * The write-side companion to `submission-overrides.ts`'s read-side
 * `overriddenFieldNames()`. The wizard UI already knows which keys it
 * prefilled versus which the certifier then typed over — it sends the
 * touched key on the next `saveDraftStep`, and this just unions it into the
 * stored set rather than trusting the client to also resend the earlier ones.
 */
export function recordOverride(existing: string[], fieldKey: string): string[] {
	return existing.includes(fieldKey) ? existing : [...existing, fieldKey];
}

/** Re-exported so callers keep one import for the wizard's rules; defined in `photo-rules.ts`. */
export { isOwnPhotoPath };

/** Every `wizard_data` key that makes sense for one assembly type. */
export function allowedWizardKeys(
	bfaType: (typeof BFA_TYPES)[number],
): Set<string> {
	const keys = new Set<string>([
		...Object.values(ASSEMBLY_FIELD_KEYS),
		...PHOTO_PATH_KEYS,
		CUSTOMER_NAME_KEY,
		CUSTOMER_EMAIL_KEY,
		SIGN_OFF_DISCLAIMER_KEY,
		"comments",
		ADP_KEY,
		LINE_PRESSURE_KEY,
		WATER_METER_START_KEY,
		WATER_METER_END_KEY,
		INITIAL_TEST_KEY,
		ISOLATES_PROPERTY_KEY,
	]);

	for (const question of wizardQuestionsFor(bfaType)) {
		keys.add(question.key);
		if (question.valueKey) keys.add(question.valueKey);
	}

	return keys;
}

/**
 * What a client-sent `wizard_data` is allowed to keep: only keys that belong
 * to the assembly type (a type change leaves the old type's answers behind
 * otherwise), only photo paths inside this submission's own folder, and never
 * the sign-off disclaimer, which the server alone writes at submit. With no
 * submission id yet, no photo path can be legitimate.
 */
export function cleanWizardData<T extends Record<string, unknown>>(
	bfaType: (typeof BFA_TYPES)[number],
	data: T,
	submissionId: string | undefined,
): Record<string, unknown> {
	const allowed = allowedWizardKeys(bfaType);
	const photoKeys = new Set<string>(PHOTO_PATH_KEYS);
	const cleaned: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(data)) {
		if (!allowed.has(key) || key === SIGN_OFF_DISCLAIMER_KEY) continue;
		if (photoKeys.has(key)) {
			if (
				value === null ||
				(submissionId && isOwnPhotoPath(submissionId, value))
			)
				cleaned[key] = value;
			continue;
		}
		cleaned[key] = value;
	}

	return cleaned;
}

/** Answers copied from a BIN's last test onto a new one: its readings, never that visit's photos, customer, comments or sign-off. */
export function carryOverAnswers(
	bfaType: (typeof BFA_TYPES)[number],
	data: Record<string, unknown>,
): Record<string, unknown> {
	const cleaned = cleanWizardData(bfaType, data, undefined);
	const visitOnly = new Set<string>([
		...PHOTO_PATH_KEYS,
		CUSTOMER_NAME_KEY,
		CUSTOMER_EMAIL_KEY,
		"comments",
	]);

	return Object.fromEntries(
		Object.entries(cleaned).filter(([key]) => !visitOnly.has(key)),
	);
}
