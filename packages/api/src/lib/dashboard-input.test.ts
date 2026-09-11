import { describe, expect, it } from "vitest";

import {
	HOME_LIST_DEFAULT_LIMIT,
	HOME_LIST_MAX_LIMIT,
	homeListInput,
	passFailBreakdownInput,
} from "./dashboard-input";

/**
 * What the dashboard's two input shapes accept, and — more to the point — what
 * they refuse.
 *
 * The tenant is the thing being asserted about here as much as the dates: no
 * shape in this router has a `waterPurveyorId`, so a client sending one is
 * sending a field the server does not read. The strict shape proves that
 * loudly, by refusing the request rather than dropping the field, because a
 * silently ignored field looks like a successful request to whatever sent it.
 */

describe("homeListInput", () => {
	it("defaults to a short preview when nothing is sent", () => {
		expect(homeListInput.parse(undefined)).toEqual({
			limit: HOME_LIST_DEFAULT_LIMIT,
		});
	});

	it("defaults the same way for an empty object", () => {
		expect(homeListInput.parse({})).toEqual({ limit: HOME_LIST_DEFAULT_LIMIT });
	});

	it("takes a caller's own limit", () => {
		expect(homeListInput.parse({ limit: 10 }).limit).toBe(10);
	});

	it("caps the limit, so a home preview cannot be turned into a full export", () => {
		expect(() =>
			homeListInput.parse({ limit: HOME_LIST_MAX_LIMIT + 1 }),
		).toThrow();
	});

	it("refuses a limit of zero or less", () => {
		expect(() => homeListInput.parse({ limit: 0 })).toThrow();
		expect(() => homeListInput.parse({ limit: -5 })).toThrow();
	});

	it("refuses a fractional limit", () => {
		expect(() => homeListInput.parse({ limit: 2.5 })).toThrow();
	});
});

describe("passFailBreakdownInput", () => {
	it("accepts a well-formed range", () => {
		expect(
			passFailBreakdownInput.parse({ from: "2026-01-01", to: "2026-03-31" }),
		).toEqual({ from: "2026-01-01", to: "2026-03-31" });
	});

	it("accepts a single day, both bounds being inclusive", () => {
		expect(
			passFailBreakdownInput.parse({ from: "2026-02-14", to: "2026-02-14" }),
		).toEqual({ from: "2026-02-14", to: "2026-02-14" });
	});

	it("requires both bounds — a chart has to say what it is counting", () => {
		expect(() =>
			passFailBreakdownInput.parse({ from: "2026-01-01" }),
		).toThrow();
		expect(() => passFailBreakdownInput.parse({ to: "2026-01-01" })).toThrow();
		expect(() => passFailBreakdownInput.parse({})).toThrow();
	});

	it("refuses a range that ends before it starts", () => {
		expect(() =>
			passFailBreakdownInput.parse({ from: "2026-03-31", to: "2026-01-01" }),
		).toThrow(/end of the range comes before its start/i);
	});

	it("refuses a date that is not a calendar day", () => {
		expect(() =>
			passFailBreakdownInput.parse({ from: "01/01/2026", to: "2026-03-31" }),
		).toThrow();
		expect(() =>
			passFailBreakdownInput.parse({ from: "2026-13-01", to: "2026-13-31" }),
		).toThrow();
	});

	// The tenant assertion. `waterPurveyorId` is not a field here, and the shape
	// is strict so that sending one is an error rather than a no-op.
	it("refuses a client-supplied water purveyor id outright", () => {
		expect(() =>
			passFailBreakdownInput.parse({
				from: "2026-01-01",
				to: "2026-03-31",
				waterPurveyorId: "11111111-1111-4111-8111-111111111111",
			}),
		).toThrow();
	});
});
