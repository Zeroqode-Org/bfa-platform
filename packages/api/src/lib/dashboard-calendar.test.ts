import { describe, expect, it } from "vitest";

import {
	monthRangeOf,
	passRate,
	TREND_MONTHS,
	trailingMonths,
	trailingMonthsRange,
} from "./dashboard-calendar";

/**
 * The dashboard's calendar arithmetic, with no database anywhere near it.
 *
 * These are the edge cases that decide whether a number on a purveyor's home
 * screen is right: which day a month ends on, what happens to a trailing window
 * that crosses a year, and whether a month nobody tested in is distinguishable
 * from a month everything failed in. Every one of them is a pure function of a
 * `Date`, so every one of them is asserted here rather than through Postgres.
 */

/** An instant, written the way the assertions below read. */
function at(iso: string): Date {
	return new Date(iso);
}

describe("monthRangeOf", () => {
	it("bounds a 31-day month", () => {
		expect(monthRangeOf(at("2026-01-17T13:22:00Z"))).toEqual({
			month: "2026-01",
			start: "2026-01-01",
			end: "2026-01-31",
		});
	});

	it("bounds a 30-day month", () => {
		expect(monthRangeOf(at("2026-04-30T23:59:59Z")).end).toBe("2026-04-30");
	});

	it("bounds a non-leap February at the 28th", () => {
		expect(monthRangeOf(at("2026-02-14T00:00:00Z"))).toEqual({
			month: "2026-02",
			start: "2026-02-01",
			end: "2026-02-28",
		});
	});

	it("bounds a leap February at the 29th", () => {
		expect(monthRangeOf(at("2028-02-01T00:00:00Z")).end).toBe("2028-02-29");
	});

	it("bounds December without rolling into the next year", () => {
		expect(monthRangeOf(at("2026-12-31T23:00:00Z"))).toEqual({
			month: "2026-12",
			start: "2026-12-01",
			end: "2026-12-31",
		});
	});

	it("pads single-digit months and days, so the keys sort as text", () => {
		const { month, start, end } = monthRangeOf(at("2026-09-05T00:00:00Z"));

		expect(month).toBe("2026-09");
		expect(start).toBe("2026-09-01");
		expect(end).toBe("2026-09-30");
	});

	// The one zone-dependent step in the module, and this is the assertion that
	// pins it: naming the calendar day an instant falls on. Done in UTC so a
	// month is a property of the data rather than of where the server runs — the
	// documented trade being that the last hours of a month's final day already
	// count as the next month for a reader west of UTC. The bounds it hands back
	// are then plain calendar dates, compared against a `date` column with no
	// zone anywhere in the comparison.
	it("names an instant's calendar day in UTC, not in the runtime's local zone", () => {
		expect(monthRangeOf(at("2026-05-31T23:30:00Z")).month).toBe("2026-05");
		expect(monthRangeOf(at("2026-06-01T00:30:00Z")).month).toBe("2026-06");
	});
});

describe("trailingMonths", () => {
	it("returns twelve months by default, ending with the current one", () => {
		const months = trailingMonths(at("2026-09-11T00:00:00Z"));

		expect(months).toHaveLength(TREND_MONTHS);
		expect(months[months.length - 1]?.month).toBe("2026-09");
	});

	it("starts eleven months back, crossing the year boundary", () => {
		const months = trailingMonths(at("2026-09-11T00:00:00Z"));

		expect(months[0]?.month).toBe("2025-10");
		expect(months.map((month) => month.month)).toEqual([
			"2025-10",
			"2025-11",
			"2025-12",
			"2026-01",
			"2026-02",
			"2026-03",
			"2026-04",
			"2026-05",
			"2026-06",
			"2026-07",
			"2026-08",
			"2026-09",
		]);
	});

	it("is strictly chronological, which is what the chart's x-axis relies on", () => {
		const months = trailingMonths(at("2026-01-01T00:00:00Z")).map(
			(month) => month.month,
		);

		expect([...months].sort()).toEqual(months);
	});

	it("carries each month's own inclusive bounds, February included", () => {
		const months = trailingMonths(at("2028-03-15T00:00:00Z"));
		const february = months.find((month) => month.month === "2028-02");

		expect(february).toEqual({
			month: "2028-02",
			start: "2028-02-01",
			end: "2028-02-29",
		});
	});
});

describe("trailingMonthsRange", () => {
	it("spans the first day of the oldest month to the last of the newest", () => {
		const window = trailingMonthsRange(at("2026-09-11T00:00:00Z"));

		expect(window.start).toBe("2025-10-01");
		expect(window.end).toBe("2026-09-30");
		expect(window.months).toHaveLength(TREND_MONTHS);
	});

	it("ends on the real last day when the current month is February", () => {
		expect(trailingMonthsRange(at("2027-02-03T00:00:00Z")).end).toBe(
			"2027-02-28",
		);
	});

	it("refuses a window of no months rather than returning undefined bounds", () => {
		expect(() => trailingMonthsRange(at("2026-09-11T00:00:00Z"), 0)).toThrow(
			/at least one month/i,
		);
	});
});

describe("passRate", () => {
	it("is a percentage of the tests that recorded a result", () => {
		expect(passRate(3, 1)).toBe(75);
	});

	it("rounds to one decimal rather than carrying float noise", () => {
		expect(passRate(2, 1)).toBe(66.7);
	});

	// The distinction the chart is built on. A month nobody tested in is not a
	// month everything failed in, and `0` would draw a point on the floor.
	it("is null for a month with nothing tested, not zero", () => {
		expect(passRate(0, 0)).toBeNull();
	});

	it("is zero — a real, plottable zero — when every test failed", () => {
		expect(passRate(0, 4)).toBe(0);
	});

	it("is 100 when every test passed", () => {
		expect(passRate(5, 0)).toBe(100);
	});
});
