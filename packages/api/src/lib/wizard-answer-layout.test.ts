import { describe, expect, it } from "vitest";

import {
	formatPsid,
	orderedWizardAnswers,
	wizardAnswerFields,
} from "./wizard-answer-layout";

const fallback = (key: string) => `?${key}`;

describe("wizardAnswerFields", () => {
	it("lists an RPDA test in the PDF's order", () => {
		expect(wizardAnswerFields("RPDA").map((field) => field.key)).toEqual([
			"assemblyServiceAddress",
			"assemblyMake",
			"assemblyModel",
			"assemblySerialNumber",
			"assemblySize",
			"assemblyLocationText",
			"customerName",
			"customerEmail",
			"linePressure",
			"adp",
			"waterMeterStart",
			"waterMeterEnd",
			"main.reliefValveOpened",
			"main.reliefValveValue",
			"main.checkValve2ShutTight",
			"main.checkValve1ShutTight",
			"main.checkValve1Value",
			"bypass.reliefValveOpened",
			"bypass.reliefValveValue",
			"bypass.checkValve2ShutTight",
			"bypass.checkValve1ShutTight",
			"bypass.checkValve1Value",
			"isolatesEntireProperty",
			"initialTestResult",
			"comments",
			"signOffDisclaimer",
			"photo1Path",
			"photo2Path",
		]);
	});

	it("labels each valve and its reading from the spec", () => {
		const labels = Object.fromEntries(
			wizardAnswerFields("DC").map((field) => [field.key, field.label]),
		);

		expect(labels).toMatchObject({
			checkValve1ShutTight: "Check Valve 1",
			checkValve1Value: "Check Valve 1 reading",
			checkValve2Value: "Check Valve 2 reading",
		});
	});

	it("names the main line on a two-line assembly, and the relief reading as asked", () => {
		const labels = Object.fromEntries(
			wizardAnswerFields("RPDA").map((field) => [field.key, field.label]),
		);

		expect(labels["main.checkValve1ShutTight"]).toBe("Main Check Valve 1");
		expect(labels["main.reliefValveValue"]).toBe(
			"Main Differential Relief Valve opened at",
		);
		expect(labels["bypass.reliefValveValue"]).toBe(
			"Bypass Differential Relief Valve opened at",
		);
	});

	it("carries each valve's answer terms for the screens that print them", () => {
		const field = wizardAnswerFields("DC").find(
			(entry) => entry.key === "checkValve1ShutTight",
		);

		expect(field?.answers).toEqual({ yes: "Tight", no: "Leak" });
	});

	it("words the water meter as the client's sheet does", () => {
		const labels = Object.fromEntries(
			wizardAnswerFields("DCDA").map((field) => [field.key, field.label]),
		);

		expect(labels.waterMeterStart).toBe("Water meter start reading");
		expect(labels.waterMeterEnd).toBe("Water meter stop reading");
	});

	it("marks readings as PSID and photos as photos", () => {
		const kinds = Object.fromEntries(
			wizardAnswerFields("DC").map((field) => [field.key, field.kind]),
		);

		expect(kinds).toMatchObject({
			checkValve1ShutTight: "yes_no",
			checkValve1Value: "psid",
			linePressure: "value",
			photo1Path: "photo",
		});
	});

	it("asks no ADP or water meter of a DC", () => {
		const keys = wizardAnswerFields("DC").map((field) => field.key);

		expect(keys).not.toContain("adp");
		expect(keys).not.toContain("waterMeterStart");
	});
});

describe("row placement", () => {
	const columns = Object.fromEntries(
		wizardAnswerFields("RPDA").map((field) => [field.key, field.column]),
	);

	it("starts a row at each valve question and puts its reading beside it", () => {
		expect(columns).toMatchObject({
			"main.reliefValveOpened": "start",
			"main.reliefValveValue": "end",
			// No reading, so the next question starts its own row regardless.
			"main.checkValve2ShutTight": "start",
			"main.checkValve1ShutTight": "start",
			"main.checkValve1Value": "end",
		});
	});

	it("pairs line pressure with ADP and the meter readings together", () => {
		expect(columns).toMatchObject({
			linePressure: "start",
			adp: "end",
			waterMeterStart: "start",
			waterMeterEnd: "end",
		});
	});

	it("gives long text a row of its own", () => {
		expect(columns).toMatchObject({
			comments: "full",
			signOffDisclaimer: "full",
		});
	});
});

describe("orderedWizardAnswers", () => {
	it("keeps only stored answers, in display order", () => {
		const ordered = orderedWizardAnswers<number | boolean>(
			"DC",
			[
				["waterMeterEnd", 3],
				["checkValve1Value", 2],
				["linePressure", 80],
				["checkValve1ShutTight", true],
			],
			fallback,
		);

		expect(ordered.map((answer) => answer.key)).toEqual([
			"linePressure",
			"checkValve1ShutTight",
			"checkValve1Value",
			// Not a DC field: kept, after the known ones, with the fallback label.
			"waterMeterEnd",
		]);
		expect(ordered.at(-1)).toMatchObject({
			label: "?waterMeterEnd",
			kind: "value",
			value: 3,
		});
	});
});

describe("formatPsid", () => {
	it("pads a whole reading to one decimal place", () => {
		expect(formatPsid(2)).toBe("2.0");
		expect(formatPsid("8")).toBe("8.0");
	});

	it("keeps a reading that already has decimals as typed", () => {
		expect(formatPsid(3.3)).toBe("3.3");
		expect(formatPsid("3.25")).toBe("3.25");
		expect(formatPsid("7.0")).toBe("7.0");
	});

	it("leaves blank and non-numeric values alone", () => {
		expect(formatPsid(null)).toBe("");
		expect(formatPsid("")).toBe("");
		expect(formatPsid("n/a")).toBe("n/a");
	});
});
