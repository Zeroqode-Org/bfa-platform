import { z } from "zod";

import { createAssetInput } from "./asset-input";
import { CUSTOMER_FIELD_LIMITS } from "./customer-field-limits";
import { addCalendarYears, isCalendarDay } from "./honolulu-dates";
import type { UpdateSubmittedTestInput } from "./submission-input";
import {
	ASSEMBLY_FIELD_KEYS,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
} from "./wizard-input";

/**
 * Registering a brand-new assembly from a no-BIN test.
 *
 * A new BFA has no BIN yet, so the certifier leaves it blank and the purveyor
 * assigns one afterward (PRD § 7, flow 2). When a WP types that BIN into an
 * unlinked submission and saves, `updateSubmittedTest` creates the asset from
 * the test and links the two in one transaction. This module is the pure half
 * of that: which asset and which customer the test describes, or why it cannot
 * describe one yet.
 *
 * Pure, no DB import — the same reason `submission-input.ts` gives — so the
 * rules can be exercised without a Postgres.
 *
 * Confirmed rules (client, October 2026):
 *
 * - The asset's details are the test's: its BFA type, and the assembly answers
 *   the wizard stores under {@link ASSEMBLY_FIELD_KEYS}.
 * - The annual test date is the test date plus one year — the next test is due
 *   a year after this one. A test with no date cannot give one, so it is refused
 *   rather than registering an asset no reminder can ever be scheduled against.
 * - A service address is required on every asset, so a test without one is
 *   refused with a message pointing at the answer to fill in.
 * - So are the assembly's make, model, serial number, size and location
 *   (WP/Admin feedback made them required on every asset). A test missing any
 *   of them is refused the same way, naming the answers to fill in.
 * - The customer is the one the wizard recorded. Matched to an existing
 *   customer by email, created when there is none — see `customer` below.
 */

export type NewAssetPlan = {
	asset: z.infer<typeof createAssetInput>;
	/**
	 * Who the wizard recorded as the customer, or null when it recorded no
	 * usable email. The email is normalised exactly as `customer-input.ts`
	 * stores one, so matching it against `lower(btrim(email))` finds the same
	 * customer the per-purveyor unique index would. `name` is null when the
	 * wizard has none: an existing customer can still be matched by email, but
	 * a new one cannot be created without a name.
	 */
	customer: { name: string | null; email: string } | null;
};

export type NewAssetPlanResult =
	| { ok: true; plan: NewAssetPlan }
	| { ok: false; message: string };

export const MISSING_TEST_DATE_MESSAGE =
	"Add the test date before assigning a BIN — the new asset's next test is due a year after it.";

export const MISSING_SERVICE_ADDRESS_MESSAGE =
	"Add the assembly's service address in the test answers before assigning a BIN — a new asset needs one.";

/** The assembly answers every asset needs, in the order a WP reads them. */
const REQUIRED_ASSEMBLY_ANSWERS = [
	["make", ASSEMBLY_FIELD_KEYS.make],
	["model", ASSEMBLY_FIELD_KEYS.model],
	["serial number", ASSEMBLY_FIELD_KEYS.serialNumber],
	["size", ASSEMBLY_FIELD_KEYS.size],
	["assembly location", ASSEMBLY_FIELD_KEYS.location],
] as const;

/** The refusal for a test missing assembly details, naming each one. */
export function missingAssemblyDetailsMessage(labels: string[]) {
	return `Add the assembly's ${labels.join(", ")} in the test answers before assigning a BIN — a new asset needs them.`;
}

/**
 * The asset and customer a corrected no-BIN submission describes.
 *
 * Takes the correction as the WP is saving it, not the stored row, so an
 * address or a date fixed in the same save is the one the asset gets.
 */
export function newAssetFromSubmission(
	next: Pick<
		UpdateSubmittedTestInput,
		"bfaType" | "submittedBinText" | "testDate" | "wizardData"
	>,
): NewAssetPlanResult {
	if (!next.testDate || !isCalendarDay(next.testDate)) {
		return { ok: false, message: MISSING_TEST_DATE_MESSAGE };
	}

	const answers = next.wizardData;
	const serviceAddress = answerText(
		answers[ASSEMBLY_FIELD_KEYS.serviceAddress],
	);

	if (!serviceAddress) {
		return { ok: false, message: MISSING_SERVICE_ADDRESS_MESSAGE };
	}

	const missing = REQUIRED_ASSEMBLY_ANSWERS.filter(
		([, key]) => !answerText(answers[key]),
	).map(([label]) => label);

	if (missing.length > 0) {
		return { ok: false, message: missingAssemblyDetailsMessage(missing) };
	}

	// Through the asset form's own shape, so an asset registered from a test is
	// held to exactly the limits and trimming one registered by hand is.
	const parsed = createAssetInput.safeParse({
		bin: next.submittedBinText ?? "",
		bfaType: next.bfaType,
		serviceAddress,
		make: answerText(answers[ASSEMBLY_FIELD_KEYS.make]),
		model: answerText(answers[ASSEMBLY_FIELD_KEYS.model]),
		serialNumber: answerText(answers[ASSEMBLY_FIELD_KEYS.serialNumber]),
		size: answerText(answers[ASSEMBLY_FIELD_KEYS.size]),
		assemblyLocation: answerText(answers[ASSEMBLY_FIELD_KEYS.location]),
		annualTestDate: addCalendarYears(next.testDate, 1),
		currentCustomerId: null,
	});

	if (!parsed.success) {
		return {
			ok: false,
			message: parsed.error.issues[0]?.message ?? "The new asset is not valid",
		};
	}

	return {
		ok: true,
		plan: { asset: parsed.data, customer: customerFromAnswers(answers) },
	};
}

/**
 * The no-BIN asset the certifier wizard registers at submit, when the BIN was
 * blank or not found in the register (client, October 2026).
 *
 * The same details and the same annual test date `newAssetFromSubmission`
 * gives a WP-numbered asset, but no BIN — the purveyor assigns that from the
 * dashboard's No-BIN table — and no customer: the client asked that the WP
 * attach the customer by hand, so a typed email does not create one.
 *
 * Submit already requires the test date and every assembly answer, so a
 * refusal here means the request skipped the wizard's own rules.
 */
export function noBinAssetFromSubmission(next: {
	bfaType: UpdateSubmittedTestInput["bfaType"];
	testDate: string;
	wizardData: Record<string, unknown>;
}):
	| { ok: true; asset: Omit<NewAssetPlan["asset"], "bin"> }
	| { ok: false; message: string } {
	if (!isCalendarDay(next.testDate)) {
		return { ok: false, message: "The test date is not a calendar day" };
	}

	const answers = next.wizardData;
	const parsed = createAssetInput.omit({ bin: true }).safeParse({
		bfaType: next.bfaType,
		serviceAddress: answerText(answers[ASSEMBLY_FIELD_KEYS.serviceAddress]),
		make: answerText(answers[ASSEMBLY_FIELD_KEYS.make]),
		model: answerText(answers[ASSEMBLY_FIELD_KEYS.model]),
		serialNumber: answerText(answers[ASSEMBLY_FIELD_KEYS.serialNumber]),
		size: answerText(answers[ASSEMBLY_FIELD_KEYS.size]),
		assemblyLocation: answerText(answers[ASSEMBLY_FIELD_KEYS.location]),
		annualTestDate: addCalendarYears(next.testDate, 1),
		currentCustomerId: null,
	});

	if (!parsed.success) {
		return {
			ok: false,
			message: parsed.error.issues[0]?.message ?? "The new asset is not valid",
		};
	}

	return { ok: true, asset: parsed.data };
}

/**
 * The wizard's customer, if it recorded an email that is one.
 *
 * Email is the match key because it is what the purveyor's customers are
 * unique on. Without a valid one there is nothing to match and nothing a notice
 * could be sent to, so the asset is registered with no customer and the WP
 * attaches one from the asset's page — the same state an asset registered
 * before its occupant is known is already in.
 */
function customerFromAnswers(
	answers: UpdateSubmittedTestInput["wizardData"],
): NewAssetPlan["customer"] {
	const email = answerText(answers[CUSTOMER_EMAIL_KEY])?.toLowerCase() ?? null;

	if (
		!email ||
		email.length > CUSTOMER_FIELD_LIMITS.email ||
		!z.email().safeParse(email).success
	) {
		return null;
	}

	const name = answerText(answers[CUSTOMER_NAME_KEY]);

	return {
		name: name ? name.slice(0, CUSTOMER_FIELD_LIMITS.name) : null,
		email,
	};
}

/** A wizard answer as trimmed text, or null when there is nothing in it. */
function answerText(value: unknown): string | null {
	if (typeof value === "number") return String(value);
	if (typeof value !== "string") return null;

	return value.trim() || null;
}
