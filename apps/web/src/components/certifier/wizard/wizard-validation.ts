import {
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	missingAssemblyFields,
	missingTestFields,
	WATER_METER_END_KEY,
	WATER_METER_START_KEY,
	WIZARD_TEST_SPEC,
} from "@bfa-platform/api/lib/wizard-input";

import type { WizardFormState } from "./wizard-shell";
import { stepCount, stepKind } from "./wizard-steps";
import type { BfaType } from "./wizard-types";

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

/** Field keys for the parts of the form that are not `wizard_data` answers. */
export const FIELD_KEYS = {
	bin: "bin",
	customerName: "customerName",
	customerEmail: "customerEmail",
	testDate: "testDate",
	signature: "signature",
} as const;

/**
 * The `wizard_data` keys one test screen is responsible for: its section's
 * questions and their values, plus the opening meter reading on the first
 * screen and the closing reading and isolates answer on the last. The Initial
 * Test has a screen of its own.
 */
function testPageKeys(bfaType: BfaType, page: number): Set<string> {
	const spec = WIZARD_TEST_SPEC[bfaType];
	const keys = new Set<string>();

	for (const entry of spec.sections[page]?.questions ?? []) {
		keys.add(entry.key);
		if (entry.valueKey) keys.add(entry.valueKey);
	}
	if (page === 0 && spec.hasMeter) keys.add(WATER_METER_START_KEY);
	if (page >= spec.sections.length - 1) {
		if (spec.hasMeter) keys.add(WATER_METER_END_KEY);
		keys.add(ISOLATES_PROPERTY_KEY);
	}

	return keys;
}

/**
 * The keys of the fields a step still lacks, so the screen can mark exactly
 * those. Save to Draft never asks: a half-filled step saves as typed. The
 * server checks the same rules again at submit, so this is the convenience,
 * not the boundary.
 */
export function stepMissingKeys(step: number, form: WizardFormState): string[] {
	const current = stepKind(step, form.bfaType);

	switch (current.kind) {
		case "identification": {
			// The BIN is optional and need not exist in the database: a typed BIN
			// that is not found is kept as text and the assembly is entered by hand.
			// What it may not be is unchecked. A BIN typed and never looked up would
			// be filed as text even when it names a real assembly — the test lands
			// unlinked and its notices wait for a WP to link it by hand. So a typed
			// BIN must be the one last looked up, found or not, or be cleared.
			const typed = form.bin.trim();

			return typed !== "" && typed !== form.resolvedBin ? [FIELD_KEYS.bin] : [];
		}
		case "assembly":
			return missingAssemblyFields(form.wizardData);
		case "test": {
			const keys = testPageKeys(form.bfaType, current.page);

			return missingTestFields(form.bfaType, form.wizardData).filter((key) =>
				keys.has(key),
			);
		}
		case "result":
			return missingTestFields(form.bfaType, form.wizardData).filter(
				(key) => key === INITIAL_TEST_KEY,
			);
		case "closing": {
			const missing: string[] = [];

			// Both optional; an email that is typed must be valid.
			const email = form.customerEmail.trim();

			if (email !== "" && !EMAIL_PATTERN.test(email))
				missing.push(FIELD_KEYS.customerEmail);
			if (form.testDate === "") missing.push(FIELD_KEYS.testDate);
			if (
				form.signatureMethod === "" ||
				(form.signatureMethod === "signed" && !form.signatureData)
			) {
				missing.push(FIELD_KEYS.signature);
			}

			return missing;
		}
		case "review":
			return [];
	}
}

/** The first step that still lacks something, or null when the whole test is ready to submit. */
export function firstIncompleteStep(form: WizardFormState): number | null {
	const total = stepCount(form.bfaType);

	for (let step = 1; step < total; step += 1) {
		if (stepMissingKeys(step, form).length > 0) return step;
	}

	return null;
}
