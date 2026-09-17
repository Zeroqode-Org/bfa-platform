import { describe, expect, it } from "vitest";

import {
	addCalendarDays,
	addCalendarMonths,
	compareCalendarDays,
	honoluluCalendarDay,
	honoluluDayStart,
	honoluluToday,
	isCalendarDay,
	parseCalendarDay,
} from "./honolulu-dates";

/**
 * Hawaii is UTC−10 and has observed no daylight saving since 1947, so the
 * expectations below are stated as fixed ten-hour shifts. That is an assertion
 * about the zone database rather than about this module's implementation, which
 * reads the offset rather than assuming it — if a rule ever changed, these are
 * the tests that would say so out loud instead of a notice quietly going out on
 * the wrong day.
 */
describe("naming the Hawaii calendar day an instant falls on", () => {
	it("is still yesterday in Honolulu for the first ten hours of a UTC day", () => {
		// 05:00 UTC on the 15th is 19:00 on the 14th in Honolulu.
		expect(honoluluCalendarDay(new Date("2026-06-15T05:00:00Z"))).toBe(
			"2026-06-14",
		);
	});

	it("rolls over at 10:00 UTC, not at midnight UTC", () => {
		expect(honoluluCalendarDay(new Date("2026-06-15T09:59:59Z"))).toBe(
			"2026-06-14",
		);
		expect(honoluluCalendarDay(new Date("2026-06-15T10:00:00Z"))).toBe(
			"2026-06-15",
		);
	});

	it("keeps a year boundary in Hawaii, not in UTC", () => {
		// New Year's Day in UTC is still New Year's Eve on the islands.
		expect(honoluluCalendarDay(new Date("2027-01-01T02:00:00Z"))).toBe(
			"2026-12-31",
		);
	});

	it("honoluluToday reads the same clock", () => {
		const now = new Date("2026-03-01T06:30:00Z");

		expect(honoluluToday(now)).toBe(honoluluCalendarDay(now));
		expect(honoluluToday(now)).toBe("2026-02-28");
	});
});

describe("the instant a Hawaii day begins", () => {
	it("is 10:00 UTC on that date", () => {
		expect(honoluluDayStart("2026-06-15").toISOString()).toBe(
			"2026-06-15T10:00:00.000Z",
		);
	});

	it("round-trips with the day it names", () => {
		for (const day of ["2026-01-01", "2026-02-28", "2026-12-31"]) {
			expect(honoluluCalendarDay(honoluluDayStart(day))).toBe(day);
		}
	});

	it("is the first instant of the day, not the last of the one before", () => {
		const start = honoluluDayStart("2026-06-15");

		expect(honoluluCalendarDay(new Date(start.getTime() - 1))).toBe(
			"2026-06-14",
		);
		expect(honoluluCalendarDay(start)).toBe("2026-06-15");
	});

	it("refuses a day that is not a real date", () => {
		expect(() => honoluluDayStart("2026-02-30")).toThrow(/calendar day/i);
	});
});

describe("day arithmetic", () => {
	it("crosses months and years", () => {
		expect(addCalendarDays("2026-01-31", 1)).toBe("2026-02-01");
		expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addCalendarDays("2026-01-01", -1)).toBe("2025-12-31");
	});

	it("knows February's length", () => {
		expect(addCalendarDays("2026-02-28", 1)).toBe("2026-03-01");
		// 2028 is a leap year.
		expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
	});

	it("adds the escalation offsets the workflow uses", () => {
		expect(addCalendarDays("2026-06-15", 1)).toBe("2026-06-16");
		expect(addCalendarDays("2026-06-15", 32)).toBe("2026-07-17");
		expect(addCalendarDays("2026-06-15", 63)).toBe("2026-08-17");
	});
});

describe("month arithmetic", () => {
	it("keeps the day of the month when it exists", () => {
		expect(addCalendarMonths("2026-06-15", -2)).toBe("2026-04-15");
		expect(addCalendarMonths("2026-01-15", -2)).toBe("2025-11-15");
		expect(addCalendarMonths("2026-06-15", 2)).toBe("2026-08-15");
	});

	it("clamps to the end of the target month rather than rolling into the next", () => {
		// The case the bare Date constructor gets wrong: 30 February does not
		// exist, and rolling to 2 March would put a reminder in the wrong month.
		expect(addCalendarMonths("2026-04-30", -2)).toBe("2026-02-28");
		expect(addCalendarMonths("2026-03-31", -2)).toBe("2026-01-31");
		expect(addCalendarMonths("2026-12-31", 2)).toBe("2027-02-28");
	});

	it("clamps to 29 February in a leap year", () => {
		expect(addCalendarMonths("2028-04-30", -2)).toBe("2028-02-29");
	});
});

describe("validation and comparison", () => {
	it("accepts a real day and rejects everything else", () => {
		expect(isCalendarDay("2026-06-15")).toBe(true);
		expect(isCalendarDay("2026-02-30")).toBe(false);
		expect(isCalendarDay("2026-13-01")).toBe(false);
		expect(isCalendarDay("2026-6-15")).toBe(false);
		expect(isCalendarDay("2026-06-15T00:00:00Z")).toBe(false);
		expect(isCalendarDay(null)).toBe(false);
		expect(isCalendarDay(20260615)).toBe(false);
	});

	it("throws on parse rather than returning a NaN day", () => {
		expect(() => parseCalendarDay("not a day")).toThrow(/calendar day/i);
		expect(parseCalendarDay("2026-06-15")).toEqual({
			year: 2026,
			month: 6,
			day: 15,
		});
	});

	it("orders days chronologically", () => {
		expect(compareCalendarDays("2026-06-14", "2026-06-15")).toBeLessThan(0);
		expect(compareCalendarDays("2026-06-15", "2026-06-15")).toBe(0);
		expect(compareCalendarDays("2027-01-01", "2026-12-31")).toBeGreaterThan(0);
	});
});
