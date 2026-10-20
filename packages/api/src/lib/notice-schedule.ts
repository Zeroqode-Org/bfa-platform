/**
 * When each notice in the escalation chain is due, and what an asset's status
 * is, derived from one field.
 *
 * `bfa_assets.annual_test_date` is the single scheduling source (PRD § 5: "the
 * single most important field in the schema"). The water purveyor sets it when
 * it assigns the BIN, and every date below is computed from it. There is
 * deliberately no second due-date column, no per-notice date and no stored
 * schedule: a date the purveyor can correct in one place is what makes
 * correcting it reschedule the whole chain rather than leave four rows to
 * reconcile.
 *
 * The intervals are platform constants, not purveyor configuration. That is a
 * confirmed client decision (PRD § 9, "Late-notice intervals ... Fixed
 * platform-wide") and the reason they live in this module as literals rather
 * than in `water_purveyors` or `wp_feature_flags`.
 *
 * Pure: no database, no env, no I/O. The only zone-aware step — turning a due
 * day into the instant it begins — is {@link noticeRunAt}, which delegates to
 * `honolulu-dates.ts`.
 */

import {
	addCalendarDays,
	addCalendarMonths,
	addCalendarYears,
	type CalendarDay,
	compareCalendarDays,
	honoluluDayStart,
	parseCalendarDay,
} from "./honolulu-dates";
import { NOTICE_TYPES, type NoticeType } from "./notice-defaults";

/**
 * How far ahead of the due date the reminder goes out, as whole calendar
 * months.
 *
 * The requirement says "approximately two months" (PRD § 6.7, § 9). This is the
 * one place that approximation is pinned down, and the interpretation is
 * **two calendar months, clamped to the end of the month** — two months before
 * 15 June is 15 April, and two months before 30 April is 28 February (29 in a
 * leap year), because 30 February does not exist. Not 60 days, and not eight
 * weeks: a purveyor checking whether a reminder went out at the right time
 * reads a calendar, and "the fifteenth, two months earlier" is what they see
 * there.
 *
 * Changing the lead time is an edit to this constant. Nothing else names two
 * months.
 */
export const REMINDER_LEAD_MONTHS = 2;

/**
 * Each late stage's offset from the due date, in days.
 *
 * Stated as a distance from the due date rather than from the previous notice,
 * even though the requirement is phrased as a chain ("+1 day, then +31, then
 * +31"). The two say the same thing, and absolute offsets are what make a
 * stage's due day recomputable from the asset alone — which is what lets a
 * changed `annual_test_date` reschedule the chain, and what lets a held stage
 * be recognised as overdue without consulting the stage before it.
 *
 * The chain arithmetic is written out so the sum is checkable against the
 * requirement rather than being three magic numbers: 1, 1 + 31, 1 + 31 + 31.
 */
export const LATE_NOTICE_1_OFFSET_DAYS = 1;
export const LATE_NOTICE_2_OFFSET_DAYS = LATE_NOTICE_1_OFFSET_DAYS + 31;
export const FINAL_NOTICE_OFFSET_DAYS = LATE_NOTICE_2_OFFSET_DAYS + 31;

/**
 * The four stages in the order they fire. The same order
 * `notice_templates.notice_type` and `job_type` declare, taken from
 * `notice-defaults.ts` rather than retyped, so the escalation order and the
 * editor's list cannot disagree.
 */
export const NOTICE_STAGES = NOTICE_TYPES;

/** The offset applied to `annual_test_date`, per stage. Days, except the reminder. */
const STAGE_OFFSET_DAYS: Record<Exclude<NoticeType, "reminder">, number> = {
	late_notice_1: LATE_NOTICE_1_OFFSET_DAYS,
	late_notice_2: LATE_NOTICE_2_OFFSET_DAYS,
	final_notice: FINAL_NOTICE_OFFSET_DAYS,
};

/**
 * The Hawaii calendar day `stage` is due for an asset whose annual test falls
 * on `annualTestDate`.
 *
 * The reminder goes backwards by calendar months; the three late notices go
 * forwards by a fixed number of days. That asymmetry is in the requirement and
 * is the right shape for each: a reminder is a date a person reads off a
 * calendar, and a late notice is an interval an escalation policy counts out.
 */
export function noticeDueDay(
	annualTestDate: CalendarDay,
	stage: NoticeType,
): CalendarDay {
	return stage === "reminder"
		? addCalendarMonths(annualTestDate, -REMINDER_LEAD_MONTHS)
		: addCalendarDays(annualTestDate, STAGE_OFFSET_DAYS[stage]);
}

/**
 * The instant `stage` becomes due: midnight, Hawaii time, on its due day.
 *
 * Midnight rather than an office hour, because the scheduler claims whatever is
 * due and the tick that picks it up decides the clock time. What the product
 * promises is the *day*, and midnight in Honolulu is the earliest instant that
 * day exists.
 */
export function noticeRunAt(
	annualTestDate: CalendarDay,
	stage: NoticeType,
): Date {
	return honoluluDayStart(noticeDueDay(annualTestDate, stage));
}

/**
 * The stage that follows `stage`, or `null` after the final notice.
 *
 * Read by the handler, which schedules exactly one successor after a successful
 * send. The chain is never pre-created: a pending `final_notice` row sitting in
 * the table for two months would be a notice that a passing test, a changed
 * date or a switched-off feature flag all have to remember to cancel, and one
 * row that does not exist yet cannot be forgotten.
 */
export function nextNoticeStage(stage: NoticeType): NoticeType | null {
	const index = NOTICE_STAGES.indexOf(stage);

	if (index < 0) return null;

	return NOTICE_STAGES[index + 1] ?? null;
}

export type AssetStatus = "active" | "due_soon" | "past_due";

/**
 * What `bfa_assets.asset_status` should be on `today`, for an asset whose
 * annual test falls on `annualTestDate`.
 *
 * Scheduler-owned, never user-written: no mutation accepts a status, the column
 * has no UPDATE grant for it, and this is the only definition of the three
 * values.
 *
 * - **`past_due`** once the due day itself has passed. On the due date the
 *   assembly is not yet late — that is the day the test may still be done, and
 *   it is why late notice 1 is due the day *after*.
 * - **`due_soon`** from the reminder day up to and including the due date. The
 *   window the reminder opens and the window the dashboard colours are the same
 *   window, deliberately: a purveyor seeing `due_soon` on a row should be able
 *   to assume the customer has been written to.
 * - **`active`** otherwise, including an asset with no annual test date at all.
 *   No date means nothing is scheduled and nothing is overdue — the asset is on
 *   the register but not on the reminder engine, which is exactly the state a
 *   newly registered assembly awaiting a BIN assignment is in.
 */
export function assetStatusFor(
	annualTestDate: CalendarDay | null,
	today: CalendarDay,
): AssetStatus {
	if (!annualTestDate) return "active";

	if (compareCalendarDays(today, annualTestDate) > 0) return "past_due";

	return compareCalendarDays(today, noticeDueDay(annualTestDate, "reminder")) >=
		0
		? "due_soon"
		: "active";
}

/**
 * The annual test date a passing test moves an assembly to, or `null` when it
 * should not move (WP/Admin feedback: "after a test is submitted, the due date
 * should move to next year so the annual reminder email can go out").
 *
 * The day and month stay the assembly's own — only the year changes. The new
 * date is the first anniversary that falls more than
 * {@link REMINDER_LEAD_MONTHS} after the test:
 *
 * - due 1 Sep 2023, passed 7 Oct 2026 (three years late) → 1 Sep **2027** — the
 *   client's own example;
 * - due 1 Sep 2027, passed early on 1 Aug 2027 → 1 Sep **2028**: a test inside
 *   the reminder window counts for this year's cycle, so next year's is due;
 * - due 1 Sep 2027, passed on 1 Jun 2027 → no move: a test that early is not
 *   this cycle's, and the reminder still goes out as scheduled.
 *
 * Never backwards: a late-linked pass from years ago computes a date no later
 * than the one stored, and that is `null` too. 29 February becomes 28 February
 * in a year without one, the same clamp `addCalendarYears` applies everywhere.
 */
export function nextAnnualTestDate(
	annualTestDate: CalendarDay,
	testDate: CalendarDay,
): CalendarDay | null {
	const threshold = addCalendarMonths(testDate, REMINDER_LEAD_MONTHS);
	const baseYear = parseCalendarDay(annualTestDate).year;
	const thresholdYear = parseCalendarDay(threshold).year;

	let next = addCalendarYears(annualTestDate, thresholdYear - baseYear);
	if (compareCalendarDays(next, threshold) <= 0) {
		next = addCalendarYears(annualTestDate, thresholdYear + 1 - baseYear);
	}

	return compareCalendarDays(next, annualTestDate) > 0 ? next : null;
}
