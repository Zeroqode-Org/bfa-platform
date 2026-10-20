import { describe, expect, it } from "vitest";

import {
	answerColumnClass,
	humanizeFieldName,
	wizardChoiceLabel,
	wizardChoiceOptions,
} from "./wizard-answers";

describe("humanizeFieldName", () => {
	it("capitalises every word, splitting the check group on its dot", () => {
		expect(humanizeFieldName("bypass.checkValve1ShutTight")).toBe(
			"Bypass Check Valve1 Shut Tight",
		);
		expect(humanizeFieldName("main.reliefValveOpened")).toBe(
			"Main Relief Valve Opened",
		);
		expect(humanizeFieldName("initialTestResult")).toBe("Initial Test Result");
		expect(humanizeFieldName("water_meter-end")).toBe("Water Meter End");
	});

	it("spells known abbreviations in capitals", () => {
		expect(humanizeFieldName("adp")).toBe("ADP");
	});

	it("falls back to the key when there are no words in it", () => {
		expect(humanizeFieldName("__")).toBe("__");
	});
});

describe("coded wizard answers", () => {
	it("labels the two button-group answers as the wizard does", () => {
		expect(wizardChoiceLabel("initialTestResult", "fail")).toBe("Fail");
		expect(wizardChoiceLabel("isolatesEntireProperty", "yes")).toBe("Yes");
		expect(wizardChoiceLabel("isolatesEntireProperty", "undetermined")).toBe(
			"Undetermined",
		);
	});

	it("offers the wizard's choices in the wizard's order", () => {
		expect(
			Object.keys(wizardChoiceOptions("isolatesEntireProperty") ?? {}),
		).toEqual(["yes", "no", "undetermined"]);
		expect(wizardChoiceOptions("linePressure")).toBeNull();
	});

	it("leaves other answers and unknown codes alone", () => {
		expect(wizardChoiceLabel("comments", "yes")).toBeNull();
		expect(wizardChoiceLabel("initialTestResult", "maybe")).toBeNull();
		expect(wizardChoiceLabel("initialTestResult", true)).toBeNull();
	});
});

describe("answerColumnClass", () => {
	it("maps a placement to grid classes, prefixed for a responsive grid", () => {
		expect(answerColumnClass("start")).toBe("col-start-1");
		expect(answerColumnClass("end", true)).toBe("sm:col-start-2");
		expect(answerColumnClass("full", true)).toBe("sm:col-span-2");
		expect(answerColumnClass(undefined)).toBeUndefined();
	});
});
