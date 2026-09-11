/**
 * The calendar arithmetic behind the dashboard's three time-bounded numbers:
 * "tests this month", the trailing twelve-month trend, and the bounds a
 * pass/fail range is validated against.
 *
 * Pure functions in their own file rather than inline in the router, for the
 * reason `asset-input.ts` gives: `routers/dashboard.ts` imports
 * `@bfa-platform/db`, and importing a Postgres connection to assert that
 * February has 28 days would make a pure rule need a database.
 *
 * **What these produce are calendar dates, not instants.**
 * `test_submissions.test_date` and `bfa_assets.annual_test_date` are Postgres
 * `date` columns — a calendar day, with no time and no zone on it. Comparing
 * one against `'2026-09-01'` is therefore a plain calendar comparison: there is
 * no zone in it to get wrong, no time component for an inclusive upper bound to
 * clip, and "the 1st to the 30th" means exactly those thirty days for every
 * reader, wherever they are.
 *
 * **The one zone-dependent step is naming the day "now" falls on.** Every
 * function below takes a `Date` — an instant off the server clock — and has to
 * decide which calendar day that is before any of the above applies. *That*
 * conversion is done in UTC, through `getUTC*` and `Date.UTC`, so which month a
 * figure covers is a property of the data rather than of where the process
 * happens to run — and so these functions are testable without pinning `TZ`.
 *
 * The cost is the honest one, and it is confined to that single step: for a
 * purveyor west of UTC, the last few hours of a month's final day already count
 * as the next month. Stated in the docs rather than hidden. Everything
 * downstream of the conversion is zone-free calendar arithmetic.
 */

/** A `YYYY-MM-DD` calendar day, the spelling a Postgres `date` compares against. */
export type CalendarDay = string;

/** A `YYYY-MM` month key. Sorts chronologically as a plain string. */
export type MonthKey = string;

/** One month of the trend, before any rows have been counted into it. */
export type TrendMonth = {
	/** `YYYY-MM`. The key the SQL grouping produces and the UI renders from. */
	month: MonthKey;
	/** Inclusive first day of the month. */
	start: CalendarDay;
	/** Inclusive last day of the month. */
	end: CalendarDay;
};

/** How many months the compliance trend covers, current month included. */
export const TREND_MONTHS = 12;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * The `YYYY-MM-DD` naming the calendar day an instant falls on.
 *
 * This is the file's one zone-dependent step — see the note above. The string
 * it returns carries no zone at all; it is the spelling a `date` column is
 * compared against.
 */
function toCalendarDay(date: Date): CalendarDay {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * The calendar month `moment` falls in, as an inclusive day range.
 *
 * The last day is found by asking for day 0 of the *next* month, which is
 * Postgres's and JavaScript's shared way of saying "the last day of this one"
 * — so February, leap years and 30-day months need no table.
 */
export function monthRangeOf(moment: Date): TrendMonth {
	const year = moment.getUTCFullYear();
	const monthIndex = moment.getUTCMonth();

	return {
		month: `${year}-${pad(monthIndex + 1)}`,
		start: toCalendarDay(new Date(Date.UTC(year, monthIndex, 1))),
		end: toCalendarDay(new Date(Date.UTC(year, monthIndex + 1, 0))),
	};
}

/**
 * The trailing twelve calendar months ending with the month `moment` falls in,
 * oldest first.
 *
 * Twelve entries always, whether or not any of them has a row in it. The
 * chart's x-axis is a property of the calendar rather than of the data, and a
 * trend that silently dropped a quiet month would draw a straight line through
 * a gap and call it continuity.
 *
 * `Date.UTC(year, monthIndex - 11, 1)` is deliberate: passing a negative month
 * index rolls the year back, so December through February needs no special
 * case.
 */
export function trailingMonths(
	moment: Date,
	count: number = TREND_MONTHS,
): TrendMonth[] {
	const year = moment.getUTCFullYear();
	const monthIndex = moment.getUTCMonth();

	return Array.from({ length: count }, (_, offset) =>
		monthRangeOf(
			new Date(Date.UTC(year, monthIndex - (count - 1 - offset), 1)),
		),
	);
}

/**
 * The whole trailing-twelve-month window as one inclusive day range, for the
 * single `where` clause the trend query runs.
 *
 * One range rather than twelve: the grouping happens in Postgres and the months
 * are re-attached in TypeScript, so twelve predicates would be twelve ways of
 * saying the same thing to the same index.
 */
export function trailingMonthsRange(
	moment: Date,
	count: number = TREND_MONTHS,
) {
	const months = trailingMonths(moment, count);
	const first = months[0];
	const last = months[months.length - 1];

	// `count` is a positive constant at every call site; the check is here so a
	// future caller cannot get an undefined bound back as a silent `undefined`
	// in a SQL predicate.
	if (!first || !last) {
		throw new Error("A trend window needs at least one month");
	}

	return { months, start: first.start, end: last.end };
}

/**
 * A month's pass rate as a percentage, or `null` when nothing was tested.
 *
 * `null` rather than `0`, and that distinction is the whole point: a month in
 * which nobody tested anything is not a month in which every test failed. The
 * chart breaks its line across a `null` and draws a point on a `0`.
 *
 * Rounded to one decimal place so the axis does not carry sixteen digits of
 * float noise, which is more precision than a rate over a handful of tests has.
 */
export function passRate(passCount: number, failCount: number): number | null {
	const total = passCount + failCount;

	if (total === 0) return null;

	return Math.round((passCount / total) * 1000) / 10;
}
