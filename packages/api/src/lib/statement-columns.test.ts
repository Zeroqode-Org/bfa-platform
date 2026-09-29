import { describe, expect, it } from "vitest";

import {
	type StatementRow,
	statementCsv,
	statementFileName,
} from "./statement-columns";

/**
 * The statement's file format on its own. Which rows go into it — tenancy,
 * drafts, the date range, the customer on the test date — is the export
 * procedure's job and is covered in `routers/submitted-tests.test.ts`.
 */

const row: StatementRow = {
	customerName: "Kaʻahumanu Farms",
	bin: "HRB-0142",
	submittedBinText: "HRB-0142",
	serviceAddress: "12 Makai Rd",
	bfaType: "RP",
	testDate: "2027-04-01",
	testResult: "pass",
	certifierName: "Kai Certifier",
};

function lines(csv: string) {
	return csv.replace(/^﻿/, "").split("\r\n");
}

describe("statementCsv", () => {
	it("writes the build plan's columns, in order", () => {
		expect(lines(statementCsv([]))[0]).toBe(
			"BIN,Customer name,Service address,BFA type,Test date,Result,Certifier",
		);
	});

	it("writes one line per row, with the date as a US calendar day", () => {
		expect(lines(statementCsv([row]))[1]).toBe(
			"HRB-0142,Kaʻahumanu Farms,12 Makai Rd,RP,04/01/2027,Pass,Kai Certifier",
		);
	});

	it("starts with a byte-order mark and ends each line with CRLF", () => {
		const csv = statementCsv([row]);

		expect(csv.startsWith("﻿")).toBe(true);
		expect(csv.endsWith("\r\n")).toBe(true);
	});

	it("is a header and nothing else when no test matched", () => {
		expect(lines(statementCsv([]))).toEqual([expect.any(String), ""]);
	});

	it("falls back to the typed BIN for a submission that never resolved", () => {
		const line = lines(
			statementCsv([
				{
					...row,
					bin: null,
					submittedBinText: "TYPED-ONLY",
					customerName: null,
					serviceAddress: null,
				},
			]),
		)[1];

		expect(line).toBe("TYPED-ONLY,,,RP,04/01/2027,Pass,Kai Certifier");
	});

	it("leaves a missing date and result blank rather than inventing one", () => {
		const line = lines(
			statementCsv([{ ...row, testDate: null, testResult: null }]),
		)[1];

		expect(line).toBe(
			"HRB-0142,Kaʻahumanu Farms,12 Makai Rd,RP,,,Kai Certifier",
		);
	});

	it("quotes a cell holding a comma, a quote or a line break", () => {
		const line = statementCsv([
			{
				...row,
				customerName: 'Hale "Big" Farms, LLC',
				serviceAddress: "12 Makai Rd\nUnit 4",
			},
		]);

		expect(line).toContain('"Hale ""Big"" Farms, LLC"');
		expect(line).toContain('"12 Makai Rd\nUnit 4"');
	});

	it.each(["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])(
		"defuses a cell a spreadsheet would run as a formula: %j",
		(value) => {
			// In the BIN, the first cell of the line — and a value a certifier
			// types into the wizard, so exactly the kind of cell to distrust.
			const line = lines(statementCsv([{ ...row, bin: value }]))[1];

			expect(line?.replace(/^"/, "").startsWith(`'${value[0]}`)).toBe(true);
		},
	);
});

describe("statementFileName", () => {
	it("names the period it covers", () => {
		expect(statementFileName({ from: "2027-03-01", to: "2027-03-31" })).toBe(
			"submitted-tests_2027-03-01_2027-03-31.csv",
		);
	});

	it("says all for an open bound", () => {
		expect(statementFileName({})).toBe("submitted-tests_all_all.csv");
	});
});
