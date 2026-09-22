import { describe, expect, it } from "vitest";

import { FAIL_LIST_ENTRY_DAYS, failListEntryCutoff } from "./fail-list-rule";

/**
 * The fail list's 30-day boundary, as arithmetic. The database suite proves
 * the query applies it; this proves the cutoff it is handed is exactly 30 × 24
 * hours before `now`, with no calendar or zone arithmetic in between.
 */
describe("failListEntryCutoff", () => {
	const failedAt = new Date("2026-01-10T12:00:00.000Z");
	const plus = (ms: number) => new Date(failedAt.getTime() + ms);
	const DAY = 86_400_000;

	/** The rule the query applies: listed iff the episode start <= cutoff. */
	const listedAt = (now: Date) => failedAt <= failListEntryCutoff(now);

	it("is thirty days", () => {
		expect(FAIL_LIST_ENTRY_DAYS).toBe(30);
	});

	it("is exactly 30 × 24 hours before now", () => {
		expect(failListEntryCutoff(plus(30 * DAY))).toEqual(failedAt);
	});

	it("does not list a failure 29 days old", () => {
		expect(listedAt(plus(29 * DAY))).toBe(false);
	});

	it("does not list it one millisecond before 30 days have elapsed", () => {
		expect(listedAt(plus(30 * DAY - 1))).toBe(false);
	});

	it("lists it the instant 30 days have elapsed, and afterwards", () => {
		expect(listedAt(plus(30 * DAY))).toBe(true);
		expect(listedAt(plus(30 * DAY + 1))).toBe(true);
		expect(listedAt(plus(90 * DAY))).toBe(true);
	});

	// March 2026 has a US daylight-saving change on the 8th. A calendar-aware
	// interval in a US session zone would put the boundary an hour off; fixed
	// 24-hour days do not.
	it("is not moved by a daylight-saving change inside the window", () => {
		const beforeDst = new Date("2026-03-01T12:00:00.000Z");
		const now = new Date(beforeDst.getTime() + 30 * DAY);

		expect(failListEntryCutoff(now)).toEqual(beforeDst);
	});
});
