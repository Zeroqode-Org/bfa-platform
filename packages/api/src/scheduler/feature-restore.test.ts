import { describe, expect, it, vi } from "vitest";

vi.mock("@bfa-platform/db", () => ({ db: {} }));

const { agRenewalNeedsRestore, currentStageFrom, noticeStageToRestore } =
	await import("./feature-restore");
const { CANCEL_REASONS } = await import("./notice-chain");
const { AG_RENEWAL_CANCEL_REASONS } = await import("./ag-renewal");

/**
 * The rule that decides which chains switching a feature on brings back. Only
 * a newest job that the switch-off itself cancelled counts — anything else had
 * the last word for a reason the flag must not override.
 */
describe("noticeStageToRestore", () => {
	const flagCancelled = (jobType: string) => ({
		jobType,
		status: "cancelled",
		lastError: CANCEL_REASONS.featureDisabled,
	});

	it("restores the stage the switch-off cancelled", () => {
		expect(noticeStageToRestore(flagCancelled("reminder"))).toBe("reminder");
		expect(noticeStageToRestore(flagCancelled("late_notice_2"))).toBe(
			"late_notice_2",
		);
	});

	it("leaves an asset with no notice history alone", () => {
		expect(noticeStageToRestore(undefined)).toBeNull();
	});

	it("leaves a chain another reason cancelled alone", () => {
		for (const reason of [
			CANCEL_REASONS.passingTest,
			CANCEL_REASONS.annualTestDateChanged,
			CANCEL_REASONS.noBin,
		]) {
			expect(
				noticeStageToRestore({
					jobType: "reminder",
					status: "cancelled",
					lastError: reason,
				}),
			).toBeNull();
		}
	});

	it("leaves a live, completed or failed job alone", () => {
		for (const status of ["pending", "running", "completed", "failed"]) {
			expect(
				noticeStageToRestore({
					jobType: "reminder",
					status,
					lastError: CANCEL_REASONS.featureDisabled,
				}),
			).toBeNull();
		}
	});

	it("never turns a non-notice job into a notice", () => {
		expect(noticeStageToRestore(flagCancelled("ag_renewal"))).toBeNull();
	});
});

describe("agRenewalNeedsRestore", () => {
	it("is true only for a renewal the switch-off cancelled", () => {
		expect(
			agRenewalNeedsRestore({
				jobType: "ag_renewal",
				status: "cancelled",
				lastError: AG_RENEWAL_CANCEL_REASONS.featureDisabled,
			}),
		).toBe(true);
		expect(
			agRenewalNeedsRestore({
				jobType: "ag_renewal",
				status: "cancelled",
				lastError: AG_RENEWAL_CANCEL_REASONS.renewalDateChanged,
			}),
		).toBe(false);
		expect(agRenewalNeedsRestore(undefined)).toBe(false);
	});
});

/**
 * One email for where the calendar is now: a restored chain never replays the
 * stages it missed, and never goes back before the stage that was cancelled.
 */
describe("currentStageFrom", () => {
	it("keeps the cancelled stage while it is still ahead", () => {
		expect(currentStageFrom("reminder", "2027-01-15", "2026-10-01")).toBe(
			"reminder",
		);
	});

	it("keeps the cancelled stage on and after its own day, until the next is due", () => {
		// Reminder due 2026-11-15; late notice 1 not until 2027-01-16.
		expect(currentStageFrom("reminder", "2027-01-15", "2026-11-17")).toBe(
			"reminder",
		);
	});

	it("skips to the latest stage already due", () => {
		// 2026-10-09: late notice 1 on 10-10, late notice 2 on 11-10, final on 12-11.
		expect(currentStageFrom("reminder", "2026-10-09", "2026-11-17")).toBe(
			"late_notice_2",
		);
	});

	it("sends only the final notice for a long-overdue assembly", () => {
		expect(currentStageFrom("reminder", "2024-06-04", "2026-11-17")).toBe(
			"final_notice",
		);
	});

	it("never goes back before the cancelled stage", () => {
		expect(currentStageFrom("late_notice_1", "2031-03-15", "2026-11-17")).toBe(
			"late_notice_1",
		);
	});
});
