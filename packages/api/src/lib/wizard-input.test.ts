import { describe, expect, it } from "vitest";

import {
	ASSEMBLY_FIELD_KEYS,
	allowedWizardKeys,
	carryOverAnswers,
	cleanWizardData,
	deriveTestResult,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	isOwnPhotoPath,
	missingWizardFields,
	OWNER_ABSENT_DISCLAIMER,
	parseSize,
	recordOverride,
	saveDraftStepInput,
	submitTestInput,
	WATER_METER_START_KEY,
	WIZARD_TEST_SPEC,
	wizardQuestionsFor,
	wizardRequiredFieldsFor,
} from "./wizard-input";

/**
 * The wizard's own input rules on their own — no database, no tRPC caller.
 * Mirrors `submission-input.test.ts`'s own reasoning: these are boundary
 * rules a client cannot be trusted to have applied, so they are worth
 * asserting independent of anything that would need a Postgres.
 */

describe("WIZARD_TEST_SPEC — the client's sheet, type by type", () => {
	const headings = (bfaType: keyof typeof WIZARD_TEST_SPEC) =>
		WIZARD_TEST_SPEC[bfaType].sections.map((section) => section.title);

	it("gives RPDA and RPDA-2 an RP main test, then a bypass", () => {
		expect(headings("RPDA")).toEqual([
			"RP TEST #1",
			"DA TEST #2 — BYPASS ASSEMBLY",
		]);
		expect(headings("RPDA-2")).toEqual([
			"RP TEST #1",
			"DA TEST #2 — BYPASS ASSEMBLY",
		]);
	});

	it("puts the bypass first for DCDA and DCDA-2", () => {
		expect(headings("DCDA")).toEqual([
			"DA TEST #1 — BYPASS ASSEMBLY",
			"DC TEST #2 — MAIN ASSEMBLY",
		]);
		expect(headings("DCDA-2")).toEqual([
			"DA TEST #1 — BYPASS ASSEMBLY",
			"DC TEST #2 — MAIN ASSEMBLY",
		]);
	});

	it("gives the RPDA bypass a relief valve and two check valves, the -2 bypass one", () => {
		expect(
			wizardQuestionsFor("RPDA").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(3);
		expect(
			wizardQuestionsFor("RPDA-2").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(1);
		expect(
			wizardQuestionsFor("DCDA").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(2);
		expect(
			wizardQuestionsFor("DCDA-2").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(1);
	});

	it("asks for the relief valve only in the RP family", () => {
		for (const type of ["RP", "RPDA", "RPDA-2"] as const) {
			expect(
				wizardRequiredFieldsFor(type).some((key) =>
					key.endsWith("reliefValveOpened"),
				),
			).toBe(true);
		}
		for (const type of ["DC", "DCDA", "DCDA-2", "PVB", "SVB"] as const) {
			expect(
				wizardRequiredFieldsFor(type).some((key) =>
					key.endsWith("reliefValveOpened"),
				),
			).toBe(false);
		}
	});

	it("takes ADP only for RP, RPDA and RPDA-2", () => {
		expect(
			(
				Object.keys(WIZARD_TEST_SPEC) as (keyof typeof WIZARD_TEST_SPEC)[]
			).filter((type) => WIZARD_TEST_SPEC[type].hasAdp),
		).toEqual(["RP", "RPDA", "RPDA-2"]);
	});

	it("takes water meter readings only for the four detector types", () => {
		expect(
			(
				Object.keys(WIZARD_TEST_SPEC) as (keyof typeof WIZARD_TEST_SPEC)[]
			).filter((type) => WIZARD_TEST_SPEC[type].hasMeter),
		).toEqual(["RPDA", "RPDA-2", "DCDA", "DCDA-2"]);
	});

	it("asks PVB and SVB three questions: air inlet opened, fully opened, check valve", () => {
		expect(wizardQuestionsFor("PVB").map((q) => q.key)).toEqual([
			"airInletValveOpened",
			"airInletValveFullyOpened",
			"checkValveShutTight",
		]);
		expect(WIZARD_TEST_SPEC.SVB).toBe(WIZARD_TEST_SPEC.PVB);
	});

	it("asks one Initial Test and the isolates question for every type", () => {
		for (const type of Object.keys(
			WIZARD_TEST_SPEC,
		) as (keyof typeof WIZARD_TEST_SPEC)[]) {
			const keys = wizardRequiredFieldsFor(type);
			expect(keys.filter((key) => key.endsWith("initialTestResult"))).toEqual([
				INITIAL_TEST_KEY,
			]);
			expect(keys).toContain(ISOLATES_PROPERTY_KEY);
		}
	});
});

describe("missingWizardFields", () => {
	const complete = (type: keyof typeof WIZARD_TEST_SPEC) => ({
		...Object.fromEntries(
			Object.values(ASSEMBLY_FIELD_KEYS).map((key) => [key, "x"]),
		),
		...Object.fromEntries(
			wizardRequiredFieldsFor(type).map((key) => [
				key,
				key === INITIAL_TEST_KEY ? "pass" : false,
			]),
		),
	});

	it("reports every required key missing from an empty draft", () => {
		expect(missingWizardFields("RP", {})).toEqual([
			...Object.values(ASSEMBLY_FIELD_KEYS),
			...wizardRequiredFieldsFor("RP"),
		]);
	});

	it("requires all six assembly details, prefilled or typed", () => {
		const { [ASSEMBLY_FIELD_KEYS.make]: _make, ...withoutMake } =
			complete("DC");
		expect(missingWizardFields("DC", withoutMake)).toEqual([
			ASSEMBLY_FIELD_KEYS.make,
		]);
	});

	it("treats null and a blank string the same as absent", () => {
		expect(missingWizardFields("PVB", { checkValveShutTight: null })).toContain(
			"checkValveShutTight",
		);
		expect(missingWizardFields("PVB", { checkValveShutTight: "" })).toContain(
			"checkValveShutTight",
		);
	});

	it("accepts a No answer — false is an answer, not a gap", () => {
		expect(missingWizardFields("DC", complete("DC"))).toEqual([]);
	});

	it("requires a value only when the question was answered Yes", () => {
		const yes = { ...complete("DC"), checkValve1ShutTight: true };
		expect(missingWizardFields("DC", yes)).toEqual(["checkValve1Value"]);
		expect(
			missingWizardFields("DC", { ...yes, checkValve1Value: "3.2" }),
		).toEqual([]);
	});

	it("insists on exactly pass or fail for the Initial Test", () => {
		expect(
			missingWizardFields("DC", {
				...complete("DC"),
				[INITIAL_TEST_KEY]: "maybe",
			}),
		).toEqual([INITIAL_TEST_KEY]);
	});

	it("requires the meter pair for a detector type and not for a single line", () => {
		expect(missingWizardFields("DCDA", {})).toContain(WATER_METER_START_KEY);
		expect(missingWizardFields("DC", {})).not.toContain(WATER_METER_START_KEY);
	});
});

describe("deriveTestResult", () => {
	it("is the Initial Test answer", () => {
		expect(deriveTestResult({ [INITIAL_TEST_KEY]: "pass" })).toBe("pass");
		expect(deriveTestResult({ [INITIAL_TEST_KEY]: "fail" })).toBe("fail");
	});
});

describe("recordOverride", () => {
	it("adds a new key once", () => {
		expect(recordOverride([], "customerEmail")).toEqual(["customerEmail"]);
	});

	it("does not duplicate an already-recorded key", () => {
		expect(recordOverride(["customerEmail"], "customerEmail")).toEqual([
			"customerEmail",
		]);
	});
});

describe("saveDraftStepInput", () => {
	it("accepts a half-filled step with no required-field checking at all", () => {
		const result = saveDraftStepInput.safeParse({
			waterPurveyorId: "8400a5b0-6b0a-4a6f-8b1a-000000000001",
			bfaType: "RP",
			currentStep: 1,
			wizardData: {},
		});
		expect(result.success).toBe(true);
	});
});

describe("submitTestInput", () => {
	const base = {
		id: "8400a5b0-6b0a-4a6f-8b1a-000000000002",
		waterPurveyorId: "8400a5b0-6b0a-4a6f-8b1a-000000000001",
		bfaType: "RP" as const,
		wizardData: {},
		customerName: "Jane Doe",
		customerEmail: "jane@example.com",
		testDate: "2026-01-01",
		signatureMethod: "signed" as const,
		signatureData: "data:image/png;base64,abc",
		photoPaths: [],
	};

	it("accepts a complete submission", () => {
		expect(submitTestInput.safeParse(base).success).toBe(true);
	});

	it("refuses an invalid customer email", () => {
		expect(
			submitTestInput.safeParse({ ...base, customerEmail: "not-an-email" })
				.success,
		).toBe(false);
	});

	it("carries no client-supplied test result — the server derives it", () => {
		expect("testResult" in submitTestInput.shape).toBe(false);
	});
});

describe("OWNER_ABSENT_DISCLAIMER", () => {
	it("matches the exact mandatory wording from the build plan", () => {
		expect(OWNER_ABSENT_DISCLAIMER).toBe(
			"Owner was not present - I certify under penalty of law and regulatory compliance guidelines that the assembly test values recorded above are true and accurate. The property manager was not present to sign the physical digital screen at the time of service.",
		);
	});
});

describe("assembly size, a number", () => {
	it("reads a size as a plain decimal from however it was written", () => {
		expect(parseSize("1 inch")).toBe("1");
		expect(parseSize("2 in")).toBe("2");
		expect(parseSize("3/4 inch")).toBe("0.75");
		expect(parseSize("1 1/2")).toBe("1.5");
		expect(parseSize("0.75")).toBe("0.75");
	});

	it("keeps text with no number in it rather than losing it", () => {
		expect(parseSize("large")).toBe("large");
		expect(parseSize(null)).toBe("");
	});
});

describe("photo paths and wizard-data cleaning", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const other = "22222222-2222-4222-8222-222222222222";
	const file = "33333333-3333-4333-8333-333333333333.jpg";

	it("accepts only a jpg inside the submission's own folder", () => {
		expect(isOwnPhotoPath(id, `${id}/${file}`)).toBe(true);
		expect(isOwnPhotoPath(id, `${other}/${file}`)).toBe(false);
		expect(isOwnPhotoPath(id, `${id}/../${other}/${file}`)).toBe(false);
		expect(isOwnPhotoPath(id, `${id}/notauuid.jpg`)).toBe(false);
		expect(isOwnPhotoPath(id, null)).toBe(false);
	});

	it("drops keys of another type, foreign photos and the disclaimer", () => {
		const rp = allowedWizardKeys("RP");
		const foreign = [...allowedWizardKeys("DC")].find((key) => !rp.has(key));
		const cleaned = cleanWizardData(
			"RP",
			{
				comments: "ok",
				photo1Path: `${other}/${file}`,
				photo2Path: `${id}/${file}`,
				signOffDisclaimer: "forged",
				...(foreign ? { [foreign]: "x" } : {}),
				bogus: "y",
			},
			id,
		);

		expect(cleaned).toEqual({ comments: "ok", photo2Path: `${id}/${file}` });
	});

	it("carries readings over but not a previous visit's photos or customer", () => {
		const carried = carryOverAnswers("RP", {
			initialTestResult: "pass",
			photo1Path: `${id}/${file}`,
			customerName: "Jane",
			comments: "old",
		});

		expect(carried).toEqual({ initialTestResult: "pass" });
	});
});
