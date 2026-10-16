import { describe, expect, it } from "vitest";

import type { WizardFormState } from "./wizard-shell";
import { FIELD_KEYS, stepMissingKeys } from "./wizard-validation";

/**
 * The identification screen's one rule: the BIN is optional, but a BIN that is
 * typed must be the one last looked up. Without it a certifier could type a
 * real assembly's BIN, press Next without looking it up, and file the test as
 * unlinked text.
 */

function form(overrides: Partial<WizardFormState> = {}): WizardFormState {
	return {
		id: undefined,
		bfaType: "RP",
		bin: "",
		resolvedBin: "",
		bfaAssetId: null,
		submittedBinText: null,
		prefilledKeys: new Set(),
		overriddenFields: new Set(),
		customerName: "",
		customerEmail: "",
		wizardData: {},
		testDate: "2026-10-16",
		signatureMethod: "",
		signatureData: null,
		photoPaths: [],
		...overrides,
	};
}

describe("stepMissingKeys — identification", () => {
	it("lets a test go on with no BIN at all", () => {
		expect(stepMissingKeys(1, form())).toEqual([]);
		expect(stepMissingKeys(1, form({ bin: "   " }))).toEqual([]);
	});

	it("refuses a BIN that was typed but never looked up", () => {
		expect(stepMissingKeys(1, form({ bin: "1201" }))).toEqual([FIELD_KEYS.bin]);
	});

	it("accepts a BIN once it was looked up, whether or not it was found", () => {
		// Found: linked to the asset.
		expect(
			stepMissingKeys(
				1,
				form({ bin: "1201", resolvedBin: "1201", bfaAssetId: "asset-1" }),
			),
		).toEqual([]);
		// Not found: kept as text, the assembly entered by hand.
		expect(
			stepMissingKeys(
				1,
				form({ bin: " 9999 ", resolvedBin: "9999", submittedBinText: "9999" }),
			),
		).toEqual([]);
	});

	it("asks again once the BIN is edited after its lookup", () => {
		expect(
			stepMissingKeys(1, form({ bin: "12010", resolvedBin: "1201" })),
		).toEqual([FIELD_KEYS.bin]);
	});
});
