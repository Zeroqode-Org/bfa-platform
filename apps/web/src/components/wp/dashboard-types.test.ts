import { describe, expect, it } from "vitest";

import {
	assetHref,
	daysOverdue,
	defaultBreakdownRange,
	failAgeBand,
	failingDays,
	formatCount,
	formatDay,
	formatMonth,
	formatMonthShort,
	formatPercent,
	isCalendarDate,
	PAST_DUE_LIST_ID,
	pastDueListHref,
	submittedTestHref,
} from "./dashboard-types";

/**
 * The dashboard's presentation rules, asserted without rendering anything.
 *
 * Three of these decide whether a number on screen is honest rather than merely
 * present: where a row links to, which day a date is read as, and what an asset
 * with no due date is said to be. All three are pure, so none of them needs a
 * DOM or a request.
 */

describe("submittedTestHref", () => {
	// The whole reuse story in one assertion: the incoming list points at the
	// existing Submitted Tests screen, which opens the record in its own
	// document dialog. A path of this dashboard's own here would mean a second
	// copy of that document existed.
	it("points at the Submitted Tests screen, naming the record", () => {
		expect(submittedTestHref("8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607")).toBe(
			"/wp/tests?test=8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		);
	});

	it("escapes the id rather than pasting it into a URL", () => {
		expect(submittedTestHref("a b&c=d")).toBe("/wp/tests?test=a%20b%26c%3Dd");
	});
});

describe("assetHref", () => {
	it("points at the asset's own detail route", () => {
		expect(assetHref("1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9")).toBe(
			"/wp/assets/1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		);
	});
});

describe("formatCount", () => {
	it("groups thousands, so a four-figure count is read rather than counted", () => {
		expect(formatCount(4120)).toBe("4,120");
	});

	it("leaves a genuine zero as a zero", () => {
		expect(formatCount(0)).toBe("0");
	});
});

describe("formatPercent", () => {
	it("keeps one decimal when there is one", () => {
		expect(formatPercent(66.7)).toBe("66.7%");
	});

	it("drops a trailing .0, which claims precision the rate does not have", () => {
		expect(formatPercent(100)).toBe("100%");
		expect(formatPercent(0)).toBe("0%");
	});
});

describe("month formatting", () => {
	it("reads a YYYY-MM key as its own month, not the reader's", () => {
		expect(formatMonth("2026-01")).toBe("Jan 2026");
		expect(formatMonthShort("2026-01")).toBe("Jan");
	});

	// A `YYYY-MM` key carries no zone. Inventing an instant for it and then
	// formatting that in the reader's zone would label the January point "Dec"
	// for everyone west of UTC — the whole x-axis off by one.
	it("does not shift a January key back into December", () => {
		expect(formatMonth("2026-12")).toBe("Dec 2026");
		expect(formatMonth("2027-01")).toBe("Jan 2027");
	});
});

describe("formatDay", () => {
	it("reads a calendar day back as itself, whatever zone the reader is in", () => {
		expect(formatDay("2026-09-01")).toBe("Sep 1, 2026");
	});

	it("says nothing rather than today when there is no date", () => {
		expect(formatDay(null)).toBe("—");
	});
});

describe("isCalendarDate", () => {
	it("accepts a well-formed calendar day", () => {
		expect(isCalendarDate("2026-09-11")).toBe(true);
		expect(isCalendarDate("2028-02-29")).toBe(true);
	});

	// The case that matters: a native date input hands back `""` the moment
	// somebody clears it, and sending that to the server gets a validation
	// refusal the screen would have to render as a failed request.
	it("rejects an empty value, which is what a cleared date input gives", () => {
		expect(isCalendarDate("")).toBe(false);
	});

	it("rejects a partial value", () => {
		expect(isCalendarDate("2026")).toBe(false);
		expect(isCalendarDate("2026-09")).toBe(false);
		expect(isCalendarDate("2026-9-1")).toBe(false);
	});

	it("rejects another format that is still a real date", () => {
		expect(isCalendarDate("09/11/2026")).toBe(false);
		expect(isCalendarDate("2026-09-11T00:00:00Z")).toBe(false);
	});

	// A regex alone passes this: it has the right shape, parses, and rolls
	// forward to March 2nd — so the round trip is what catches it.
	it("rejects a day that does not exist, despite the right shape", () => {
		expect(isCalendarDate("2026-02-30")).toBe(false);
		expect(isCalendarDate("2026-13-01")).toBe(false);
		expect(isCalendarDate("2027-02-29")).toBe(false);
	});
});

describe("defaultBreakdownRange", () => {
	// Deliberately the same span as the trend chart beside it: two charts on one
	// screen covering different periods is how a reader comes away with numbers
	// that do not reconcile.
	it("opens on the first day of the month eleven months back", () => {
		expect(defaultBreakdownRange("2026-09-11")).toEqual({
			from: "2025-10-01",
			to: "2026-09-11",
		});
	});

	it("rolls the year back without a special case", () => {
		expect(defaultBreakdownRange("2026-01-05").from).toBe("2025-02-01");
	});

	it("pads a single-digit month, so the value fits a date input", () => {
		expect(defaultBreakdownRange("2026-12-31").from).toBe("2026-01-01");
	});

	// What the "Last 12 months" button restores has to pass the same gate the
	// query is enabled behind, or the button would hand back a range the screen
	// then declines to send.
	it("returns two values that both read as calendar dates, and run forwards", () => {
		for (const today of [
			"2026-09-11",
			"2026-01-05",
			"2026-12-31",
			"2028-02-29",
		]) {
			const { from, to } = defaultBreakdownRange(today);

			expect(isCalendarDate(from)).toBe(true);
			expect(isCalendarDate(to)).toBe(true);
			expect(from <= to).toBe(true);
		}
	});
});

describe("daysOverdue", () => {
	it("counts whole calendar days past the annual test date", () => {
		expect(daysOverdue("2026-09-01", "2026-09-11")).toBe(10);
	});

	// `null`, not `0`. An asset the scheduler marked past due with no date to be
	// past is a data problem, and "0 days overdue" would dress that up as "due
	// today".
	it("says nothing for an asset carrying no annual test date", () => {
		expect(daysOverdue(null, "2026-09-11")).toBeNull();
	});

	it("says nothing rather than a negative count when the date is in the future", () => {
		expect(daysOverdue("2027-01-01", "2026-09-11")).toBeNull();
	});

	it("says nothing on the due date itself", () => {
		expect(daysOverdue("2026-09-11", "2026-09-11")).toBeNull();
	});

	it("crosses a year boundary without drifting", () => {
		expect(daysOverdue("2025-12-31", "2026-01-01")).toBe(1);
	});
});

describe("pastDueListHref", () => {
	it("is the Past Due list on the same screen, the Past due card's destination", () => {
		expect(pastDueListHref()).toBe(`#${PAST_DUE_LIST_ID}`);
	});
});

describe("failingDays", () => {
	it("counts whole days between the episode start and today", () => {
		expect(failingDays("2026-09-01", "2026-09-11")).toBe(10);
	});

	it("is zero on the day the failure was filed", () => {
		expect(failingDays("2026-09-11", "2026-09-11")).toBe(0);
	});

	it("clamps at zero rather than going negative", () => {
		expect(failingDays("2026-09-12", "2026-09-11")).toBe(0);
	});

	it("crosses a year boundary without drifting", () => {
		expect(failingDays("2025-12-31", "2026-01-01")).toBe(1);
	});

	it("reads 30 on the day an asset becomes eligible for the list", () => {
		expect(failingDays("2026-08-12", "2026-09-11")).toBe(30);
	});
});

describe("failAgeBand", () => {
	// A row reaches the list only after 30 days without a passing re-test, so
	// its first reachable band starts on day 30 — the entry morning itself.
	it("uses the stronger danger tint from entry on day 30 through day 60", () => {
		expect(failAgeBand(30)).toBe("days_30_to_60");
		expect(failAgeBand(45)).toBe("days_30_to_60");
		expect(failAgeBand(60)).toBe("days_30_to_60");
	});

	// The build plan's "a row crossing 60 days changes colour", pinned to the
	// exact morning it happens on.
	it("moves to the full danger colour on day 61", () => {
		expect(failAgeBand(61)).toBe("over_60");
		expect(failAgeBand(400)).toBe("over_60");
	});

	// Only a stale `today` on a page left open can produce these; they must not
	// render as an "under 30 days" state the list never actually shows.
	it("has no under-30 band: a stale figure falls into the first band", () => {
		expect(failAgeBand(0)).toBe("days_30_to_60");
		expect(failAgeBand(29)).toBe("days_30_to_60");
	});
});
