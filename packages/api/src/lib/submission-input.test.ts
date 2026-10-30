import { describe, expect, it } from "vitest";

import { SUBMISSION_FIELD_LIMITS } from "./submission-field-limits";
import {
	changedSubmissionFields,
	exportSubmittedTestsInput,
	linkSubmissionAssetInput,
	listSubmittedTestsInput,
	submissionColumns,
	updateSubmittedTestInput,
} from "./submission-input";
import {
	OVERRIDDEN_FIELD_NOTE,
	overriddenFieldNames,
} from "./submission-overrides";

/**
 * The submitted-test input rules on their own — no database, no tRPC caller.
 *
 * These are the rules a client cannot be trusted to have applied: that neither
 * the tenant nor the actor nor the status can be sent in, that a blank optional
 * field is one spelling of empty rather than two, that a date range running
 * backwards is a typo rather than an empty result, and that a save which
 * changes nothing reports nothing as changed. The tenant-boundary half of the
 * story is in `routers/submitted-tests.test.ts`, which needs a real database
 * and runs only under `npm run test:db`.
 */

const correction = {
	id: "6b3e1c22-8f4a-4d61-9c07-2a1b3c4d5e6f",
	bfaType: "RP" as const,
	submittedBinText: "HRB-0142",
	testDate: "2027-04-01",
	testResult: "pass" as const,
	signatureMethod: "signed" as const,
	signatureData: "data:image/png;base64,AAAA",
	wizardData: { reliefValveOpened: true, linePressure: 62 },
};

describe("updateSubmittedTestInput", () => {
	it("accepts a full correction", () => {
		expect(updateSubmittedTestInput.parse(correction)).toMatchObject({
			bfaType: "RP",
			submittedBinText: "HRB-0142",
			testDate: "2027-04-01",
			testResult: "pass",
			signatureMethod: "signed",
			wizardData: { reliefValveOpened: true, linePressure: 62 },
		});
	});

	it("collapses every emptied optional field to null", () => {
		// A form that has been typed into and cleared sends `""`, not `undefined`.
		// Storing that would give each column two spellings of "empty".
		const parsed = updateSubmittedTestInput.parse({
			...correction,
			submittedBinText: "   ",
			testDate: "",
			signatureData: "",
		});

		expect(parsed).toMatchObject({
			submittedBinText: null,
			testDate: null,
			signatureData: null,
		});
	});

	it("keeps a submitted test correctable when it is missing its result", () => {
		// The wizard that will guarantee a date and a result is week 4. A screen
		// that refused to save a row already missing one would be refusing to fix
		// exactly the rows that need fixing.
		const parsed = updateSubmittedTestInput.parse({
			...correction,
			testDate: null,
			testResult: null,
			signatureMethod: null,
		});

		expect(parsed).toMatchObject({
			testDate: null,
			testResult: null,
			signatureMethod: null,
		});
	});

	it("drops a tenant, an actor, a status and a certifier sent by the client", () => {
		const parsed = updateSubmittedTestInput.parse({
			...correction,
			waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
			editedByWpProfileId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
			status: "draft",
			certifierId: "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901",
			overriddenFields: [],
		});

		// Not merely ignored downstream — absent from the parsed value, so there
		// is nothing for a later refactor to accidentally spread into a write.
		expect(parsed).not.toHaveProperty("waterPurveyorId");
		expect(parsed).not.toHaveProperty("editedByWpProfileId");
		expect(parsed).not.toHaveProperty("status");
		expect(parsed).not.toHaveProperty("certifierId");
		expect(parsed).not.toHaveProperty("overriddenFields");
	});

	it("refuses a wizard answer that is a nested document", () => {
		expect(() =>
			updateSubmittedTestInput.parse({
				...correction,
				wizardData: { readings: { first: 1, second: 2 } },
			}),
		).toThrow();
	});

	it("refuses a wizard bag past the field ceiling", () => {
		const tooMany = Object.fromEntries(
			Array.from({ length: SUBMISSION_FIELD_LIMITS.wizardKeys + 1 }, (_, i) => [
				`field${i}`,
				"value",
			]),
		);

		expect(() =>
			updateSubmittedTestInput.parse({ ...correction, wizardData: tooMany }),
		).toThrow();
	});

	it("refuses a wizard answer past the value ceiling", () => {
		expect(() =>
			updateSubmittedTestInput.parse({
				...correction,
				wizardData: {
					notes: "x".repeat(SUBMISSION_FIELD_LIMITS.wizardValueLength + 1),
				},
			}),
		).toThrow();
	});

	it("refuses a BFA type outside the eight", () => {
		expect(() =>
			updateSubmittedTestInput.parse({ ...correction, bfaType: "RPZ" }),
		).toThrow();
	});
});

describe("listSubmittedTestsInput", () => {
	it("defaults to the first page with no filters", () => {
		expect(listSubmittedTestsInput.parse(undefined)).toEqual({
			page: 1,
			pageSize: 25,
		});
	});

	it("takes a result and a date range together", () => {
		// Independent filters, not a mode switch: "failures in March" is one
		// question, and making the reader choose would answer a different one.
		expect(
			listSubmittedTestsInput.parse({
				result: "fail",
				from: "2027-03-01",
				to: "2027-03-31",
			}),
		).toMatchObject({ result: "fail", from: "2027-03-01", to: "2027-03-31" });
	});

	it("accepts a single-day range", () => {
		expect(
			listSubmittedTestsInput.parse({ from: "2027-03-01", to: "2027-03-01" }),
		).toMatchObject({ from: "2027-03-01", to: "2027-03-01" });
	});

	it("refuses a range that ends before it starts", () => {
		// A typo, not an empty result. Returning nothing would let the reader
		// conclude there were no tests that month.
		expect(() =>
			listSubmittedTestsInput.parse({ from: "2027-03-31", to: "2027-03-01" }),
		).toThrow();
	});

	it("caps the page size", () => {
		expect(() => listSubmittedTestsInput.parse({ pageSize: 500 })).toThrow();
	});

	it("takes the no-BIN filter alongside the others", () => {
		// The dashboard's No-BIN "View all" lands as `?bin=none`; it narrows
		// together with a result and a period like any other filter.
		expect(
			listSubmittedTestsInput.parse({ bin: "none", result: "fail" }),
		).toMatchObject({ bin: "none", result: "fail" });
	});

	it("refuses a BIN filter it does not know", () => {
		// Dropping it would quietly show every test under a "No BIN" heading.
		expect(() => listSubmittedTestsInput.parse({ bin: "some" })).toThrow();
		expect(() => listSubmittedTestsInput.parse({ bin: true })).toThrow();
	});
});

describe("exportSubmittedTestsInput", () => {
	it("takes the list's filters, every one optional", () => {
		expect(exportSubmittedTestsInput.parse({})).toEqual({});
		expect(
			exportSubmittedTestsInput.parse({
				result: "pass",
				from: "2027-03-01",
				to: "2027-03-31",
			}),
		).toEqual({ result: "pass", from: "2027-03-01", to: "2027-03-31" });
	});

	it("refuses a range that ends before it starts", () => {
		expect(() =>
			exportSubmittedTestsInput.parse({ from: "2027-03-31", to: "2027-03-01" }),
		).toThrow();
	});

	it("takes the no-BIN filter as the query string spells it", () => {
		// Read straight off `?bin=none`, so the statement holds the rows the
		// filtered table — and the dashboard's No-BIN card — counted.
		expect(exportSubmittedTestsInput.parse({ bin: "none" })).toEqual({
			bin: "none",
		});
		expect(() => exportSubmittedTestsInput.parse({ bin: "true" })).toThrow();
	});

	it("refuses a parameter it does not know rather than dropping it", () => {
		// A misspelt bound dropped silently would widen the statement.
		expect(() =>
			exportSubmittedTestsInput.parse({ form: "2027-03-01" }),
		).toThrow();
	});

	it("has no pager: a statement is every matching row", () => {
		expect(() => exportSubmittedTestsInput.parse({ page: 2 })).toThrow();
	});
});

describe("linkSubmissionAssetInput", () => {
	it("takes exactly the two ids", () => {
		expect(
			linkSubmissionAssetInput.parse({
				submissionId: "6b3e1c22-8f4a-4d61-9c07-2a1b3c4d5e6f",
				assetId: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
			}),
		).toHaveProperty("assetId");
	});

	it("refuses a tenant sent alongside them rather than dropping it", () => {
		// Strict on purpose: a silently ignored field looks like a successful
		// request to whatever sent it.
		expect(() =>
			linkSubmissionAssetInput.parse({
				submissionId: "6b3e1c22-8f4a-4d61-9c07-2a1b3c4d5e6f",
				assetId: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
				waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
			}),
		).toThrow();
	});
});

describe("changedSubmissionFields", () => {
	const parsed = updateSubmittedTestInput.parse(correction);
	const stored = submissionColumns(parsed);

	it("reports nothing when every value is already what is stored", () => {
		// The no-op save. Writing anyway would move `updated_at` and stamp an
		// editor onto a record nobody changed.
		expect(changedSubmissionFields({ ...stored }, stored)).toEqual([]);
	});

	it("ignores a jsonb round trip that only reordered the keys", () => {
		// Postgres does not preserve `jsonb` key order, so a comparison sensitive
		// to it would report a change on every save.
		const reordered = { linePressure: 62, reliefValveOpened: true };

		expect(
			changedSubmissionFields({ ...stored, wizardData: reordered }, stored),
		).toEqual([]);
	});

	it("names the columns a real correction touches", () => {
		const changed = changedSubmissionFields(
			{ ...stored, testResult: "fail", submittedBinText: "HRB-0143" },
			stored,
		);

		expect(changed.sort()).toEqual(["submittedBinText", "testResult"]);
	});

	it("notices a wizard answer whose value changed", () => {
		expect(
			changedSubmissionFields(
				{
					...stored,
					wizardData: { reliefValveOpened: true, linePressure: 61 },
				},
				stored,
			),
		).toEqual(["wizardData"]);
	});

	it("notices a wizard answer that was added", () => {
		expect(
			changedSubmissionFields(
				{ ...stored, wizardData: { reliefValveOpened: true } },
				stored,
			),
		).toEqual(["wizardData"]);
	});

	it("carries names and never values", () => {
		// This list is what the audit line logs. A signature image or a customer's
		// details have no business in a log stream that is greppable by tenant.
		const changed = changedSubmissionFields(
			{ ...stored, signatureData: "data:image/png;base64,ZZZZ" },
			stored,
		);

		expect(changed).toEqual(["signatureData"]);
	});
});

describe("overriddenFieldNames", () => {
	it("reads an array of names", () => {
		expect([...overriddenFieldNames(["linePressure", "make"])]).toEqual([
			"linePressure",
			"make",
		]);
	});

	it("reads an object keyed by name, which a previous-value map would be", () => {
		expect([...overriddenFieldNames({ linePressure: 58 })]).toEqual([
			"linePressure",
		]);
	});

	it("treats an unreadable marker as nothing flagged rather than throwing", () => {
		// A flag nobody can parse must not stop a WP opening the record it is
		// attached to.
		for (const value of [null, undefined, 42, "linePressure"]) {
			expect(overriddenFieldNames(value).size).toBe(0);
		}
	});

	it("ignores non-string entries in an array marker", () => {
		expect([...overriddenFieldNames(["make", 7, null])]).toEqual(["make"]);
	});

	it("states what the flag means in one place", () => {
		expect(OVERRIDDEN_FIELD_NOTE).toMatch(/prefilled/i);
	});
});
