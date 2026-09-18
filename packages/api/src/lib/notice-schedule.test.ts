import { describe, expect, it } from "vitest";

import { NOTICE_TYPES } from "./notice-defaults";
import {
	assetStatusFor,
	FINAL_NOTICE_OFFSET_DAYS,
	LATE_NOTICE_1_OFFSET_DAYS,
	LATE_NOTICE_2_OFFSET_DAYS,
	nextNoticeStage,
	noticeDueDay,
	noticeRunAt,
	REMINDER_LEAD_MONTHS,
} from "./notice-schedule";

/**
 * The four stage dates, against the requirement rather than against the
 * implementation: reminder ~2 months before the annual test date, late notice 1
 * the day after it, late notice 2 thirty-one days after that, and the final
 * notice thirty-one days after *that* (PRD § 6.7, § 9).
 *
 * 15 June 2026 is used throughout because every stage lands on a different
 * month, so an off-by-one in either direction is visible rather than absorbed.
 */
const DUE = "2026-06-15";

describe("the intervals are the confirmed platform constants", () => {
	it("leads the reminder by two calendar months", () => {
		expect(REMINDER_LEAD_MONTHS).toBe(2);
	});

	it("spaces the late notices +1 / +31 / +31 from each other", () => {
		expect(LATE_NOTICE_1_OFFSET_DAYS).toBe(1);
		expect(LATE_NOTICE_2_OFFSET_DAYS - LATE_NOTICE_1_OFFSET_DAYS).toBe(31);
		expect(FINAL_NOTICE_OFFSET_DAYS - LATE_NOTICE_2_OFFSET_DAYS).toBe(31);
	});
});

describe("noticeDueDay", () => {
	it("computes all four stages from the annual test date alone", () => {
		expect(noticeDueDay(DUE, "reminder")).toBe("2026-04-15");
		expect(noticeDueDay(DUE, "late_notice_1")).toBe("2026-06-16");
		expect(noticeDueDay(DUE, "late_notice_2")).toBe("2026-07-17");
		expect(noticeDueDay(DUE, "final_notice")).toBe("2026-08-17");
	});

	it("produces a strictly increasing sequence", () => {
		const days = NOTICE_TYPES.map((stage) => noticeDueDay(DUE, stage));

		expect(days).toEqual([...days].sort());
		expect(new Set(days).size).toBe(days.length);
	});

	it("clamps the reminder into a short month rather than rolling past it", () => {
		expect(noticeDueDay("2026-04-30", "reminder")).toBe("2026-02-28");
		expect(noticeDueDay("2028-04-30", "reminder")).toBe("2028-02-29");
	});

	it("crosses a year boundary backwards for the reminder", () => {
		expect(noticeDueDay("2026-01-10", "reminder")).toBe("2025-11-10");
	});

	it("crosses a year boundary forwards for the late notices", () => {
		expect(noticeDueDay("2026-12-31", "late_notice_1")).toBe("2027-01-01");
		expect(noticeDueDay("2026-12-31", "final_notice")).toBe("2027-03-04");
	});
});

describe("noticeRunAt", () => {
	it("is midnight in Honolulu on the stage's due day — 10:00 UTC", () => {
		expect(noticeRunAt(DUE, "reminder").toISOString()).toBe(
			"2026-04-15T10:00:00.000Z",
		);
		expect(noticeRunAt(DUE, "late_notice_1").toISOString()).toBe(
			"2026-06-16T10:00:00.000Z",
		);
		expect(noticeRunAt(DUE, "late_notice_2").toISOString()).toBe(
			"2026-07-17T10:00:00.000Z",
		);
		expect(noticeRunAt(DUE, "final_notice").toISOString()).toBe(
			"2026-08-17T10:00:00.000Z",
		);
	});

	it("is not midnight UTC, which would fire on the wrong Hawaii day", () => {
		const runAt = noticeRunAt(DUE, "late_notice_1");

		expect(runAt.toISOString()).not.toBe("2026-06-16T00:00:00.000Z");
		// Midnight UTC on the 16th is still the 15th on the islands, so a job
		// scheduled there would have fired a day early.
		expect(runAt.getTime()).toBeGreaterThan(Date.parse("2026-06-16T00:00:00Z"));
	});
});

describe("nextNoticeStage", () => {
	it("walks the chain once and stops at the final notice", () => {
		expect(nextNoticeStage("reminder")).toBe("late_notice_1");
		expect(nextNoticeStage("late_notice_1")).toBe("late_notice_2");
		expect(nextNoticeStage("late_notice_2")).toBe("final_notice");
		expect(nextNoticeStage("final_notice")).toBeNull();
	});
});

describe("assetStatusFor", () => {
	it("is active while the reminder window has not opened", () => {
		expect(assetStatusFor(DUE, "2026-04-14")).toBe("active");
	});

	it("turns due_soon on the reminder day itself", () => {
		expect(assetStatusFor(DUE, "2026-04-15")).toBe("due_soon");
	});

	it("is still due_soon on the due date — that day the test can still be done", () => {
		expect(assetStatusFor(DUE, "2026-06-15")).toBe("due_soon");
	});

	it("turns past_due the day after, which is when late notice 1 is due", () => {
		expect(assetStatusFor(DUE, "2026-06-16")).toBe("past_due");
		expect(noticeDueDay(DUE, "late_notice_1")).toBe("2026-06-16");
	});

	it("is active for an asset with no annual test date", () => {
		expect(assetStatusFor(null, "2026-06-16")).toBe("active");
	});

	it("uses the clamped reminder day as the due_soon boundary", () => {
		expect(assetStatusFor("2026-04-30", "2026-02-27")).toBe("active");
		expect(assetStatusFor("2026-04-30", "2026-02-28")).toBe("due_soon");
	});
});
