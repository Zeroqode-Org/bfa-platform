import { describe, expect, it } from "vitest";

import { hawaiiToday, statementPeriods } from "./statement-periods";

function period(today: string, key: string) {
	return statementPeriods(today).find((candidate) => candidate.key === key);
}

describe("hawaiiToday", () => {
	it("names Hawaii's day, not UTC's", () => {
		// 03:00 UTC on Nov 1 is still 17:00 on Oct 31 in Honolulu.
		expect(hawaiiToday(new Date("2026-11-01T03:00:00Z"))).toBe("2026-10-31");
	});
});

describe("statementPeriods", () => {
	it("runs this month from the 1st to today", () => {
		expect(period("2026-10-02", "thisMonth")).toMatchObject({
			from: "2026-10-01",
			to: "2026-10-02",
		});
	});

	it("closes last month on its own last day", () => {
		expect(period("2026-10-02", "lastMonth")).toMatchObject({
			from: "2026-09-01",
			to: "2026-09-30",
		});
	});

	it("reaches back across the new year in January", () => {
		expect(period("2027-01-15", "lastMonth")).toMatchObject({
			from: "2026-12-01",
			to: "2026-12-31",
		});
	});

	it("knows February's length, leap year included", () => {
		expect(period("2028-03-05", "lastMonth")?.to).toBe("2028-02-29");
		expect(period("2027-03-05", "lastMonth")?.to).toBe("2027-02-28");
	});

	it("runs year to date from January 1st to today", () => {
		expect(period("2026-10-02", "yearToDate")).toMatchObject({
			from: "2026-01-01",
			to: "2026-10-02",
		});
	});
});
