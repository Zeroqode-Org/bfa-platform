/**
 * Calendar arithmetic in the one zone this product's dates mean something in.
 *
 * Every date the business cares about — `bfa_assets.annual_test_date`, the four
 * notice days derived from it, the AG renewal date — is a Hawaii calendar day
 * (PRD § 4 constraints, build plan "Timezone"). The server may run in UTC on
 * Vercel, in local time on a developer's laptop, and in whatever a Docker host
 * is set to; none of those may decide which day a notice goes out on. So the
 * conversion from an instant to a calendar day happens here, explicitly, against
 * {@link HAWAII_TIME_ZONE}, and nowhere else in the workflow.
 *
 * This is deliberately *not* `dashboard-calendar.ts`. That file names the
 * current day in UTC and says so — its figures are reporting aggregates where a
 * few hours at a month boundary shift a count. These functions decide when mail
 * is sent to a customer, where the same few hours send a reminder on the wrong
 * date, so they pay for a real zone lookup.
 *
 * Two kinds of value appear below and the difference matters:
 *
 * - A **calendar day** is a `YYYY-MM-DD` string. It carries no zone and no time,
 *   and it is the spelling a Postgres `date` column compares against. All the
 *   arithmetic on it (`addCalendarDays`, `addCalendarMonths`) is zone-free.
 * - An **instant** is a `Date`. The only two functions that cross between the
 *   two are {@link honoluluCalendarDay} and {@link honoluluDayStart}, and they
 *   are the only place the zone is consulted.
 *
 * Pure: no database, no env, no I/O. Hawaii has not observed daylight saving
 * since 1947, so its offset is a constant −10:00 in practice — nothing here
 * assumes that, because assuming it is how a zone rule change becomes a silent
 * off-by-one a decade from now.
 */

export const HAWAII_TIME_ZONE = "Pacific/Honolulu";

/** A `YYYY-MM-DD` calendar day. Sorts chronologically as a plain string. */
export type CalendarDay = string;

type DayParts = { year: number; month: number; day: number };

const CALENDAR_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `hourCycle: "h23"` rather than `hour12: false` — the latter renders midnight
 * as hour `24` in some ICU builds, which would push the offset calculation a
 * day out for exactly the instants this module cares most about.
 */
const HONOLULU_FORMATTER = new Intl.DateTimeFormat("en-US", {
	timeZone: HAWAII_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function formatDay({ year, month, day }: DayParts): CalendarDay {
	return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

function utcParts(instant: Date): DayParts {
	return {
		year: instant.getUTCFullYear(),
		month: instant.getUTCMonth() + 1,
		day: instant.getUTCDate(),
	};
}

/** Whether `value` is a well-formed, real `YYYY-MM-DD` day. */
export function isCalendarDay(value: unknown): value is CalendarDay {
	if (typeof value !== "string") return false;

	const match = CALENDAR_DAY_PATTERN.exec(value);

	if (!match) return false;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);

	// Round-tripping through UTC is what rejects `2026-02-30`: the constructor
	// rolls it into March, so the re-formatted string no longer matches.
	return (
		formatDay(utcParts(new Date(Date.UTC(year, month - 1, day)))) === value
	);
}

/**
 * `value` as day parts, or a thrown error.
 *
 * Throws rather than returning null: every caller reads a `date` column or a
 * validated input, so a malformed value is a bug upstream, and a null that
 * flowed into {@link addCalendarDays} would come back out as a `NaN` day string
 * and schedule a job at the Unix epoch.
 */
export function parseCalendarDay(value: string): DayParts {
	if (!isCalendarDay(value)) {
		throw new Error(`Not a YYYY-MM-DD calendar day: ${String(value)}`);
	}

	const match = CALENDAR_DAY_PATTERN.exec(value);

	return {
		year: Number(match?.[1]),
		month: Number(match?.[2]),
		day: Number(match?.[3]),
	};
}

type ZonedParts = DayParts & { hour: number; minute: number; second: number };

function honoluluParts(instant: Date): ZonedParts {
	const parts = new Map(
		HONOLULU_FORMATTER.formatToParts(instant).map((part) => [
			part.type,
			part.value,
		]),
	);

	const read = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.get(type);

		if (value === undefined) {
			throw new Error(`Intl gave no ${type} for ${HAWAII_TIME_ZONE}`);
		}

		return Number(value);
	};

	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour"),
		minute: read("minute"),
		second: read("second"),
	};
}

/** The Hawaii calendar day `instant` falls on. */
export function honoluluCalendarDay(instant: Date): CalendarDay {
	return formatDay(honoluluParts(instant));
}

/** Today's Hawaii calendar day. */
export function honoluluToday(now: Date = new Date()): CalendarDay {
	return honoluluCalendarDay(now);
}

/**
 * How far ahead of UTC Hawaii is at `instant`, in milliseconds. Negative.
 *
 * Read from the zone database through `Intl` rather than hardcoded: reading the
 * wall clock in Honolulu and then pretending those numbers were UTC gives the
 * offset as the difference, whatever the rule for that date happens to be. The
 * instant is truncated to whole seconds first, because `Intl` reports whole
 * seconds and the sub-second remainder would otherwise land in the offset.
 */
function honoluluOffsetMs(instant: Date): number {
	const parts = honoluluParts(instant);

	return (
		Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
		) -
		Math.floor(instant.getTime() / 1000) * 1000
	);
}

/**
 * The instant midnight begins on `day` in Hawaii — the moment a notice due that
 * day becomes due.
 *
 * Two passes, not one. The first guesses the instant using the offset in force
 * at the *UTC* midnight of that day, and the second re-reads the offset at the
 * guess. For a zone with no daylight saving the two agree and the second pass
 * changes nothing; for a zone whose rules shift near midnight it is what stops
 * the answer from landing an hour inside the previous day.
 */
export function honoluluDayStart(day: CalendarDay): Date {
	const { year, month, day: dayOfMonth } = parseCalendarDay(day);
	const utcMidnight = Date.UTC(year, month - 1, dayOfMonth);

	const firstGuess = new Date(
		utcMidnight - honoluluOffsetMs(new Date(utcMidnight)),
	);

	return new Date(utcMidnight - honoluluOffsetMs(firstGuess));
}

/** `day` moved by `days`, which may be negative. Zone-free. */
export function addCalendarDays(day: CalendarDay, days: number): CalendarDay {
	const { year, month, day: dayOfMonth } = parseCalendarDay(day);

	return formatDay(
		utcParts(new Date(Date.UTC(year, month - 1, dayOfMonth + days))),
	);
}

/**
 * `day` moved by whole calendar months, which may be negative, clamped to the
 * last day of the target month.
 *
 * Calendar months, not 30-day blocks: two months before 1 April is 1 February,
 * which is what a person setting an annual test date means and what they would
 * check a calendar for. The clamp is the only case where the day number moves —
 * two months before 30 April is 28 or 29 February, because 30 February does not
 * exist. Rolling into March instead (which is what the `Date` constructor does
 * unaided) would put a reminder in the wrong month.
 */
export function addCalendarMonths(
	day: CalendarDay,
	months: number,
): CalendarDay {
	const { year, month, day: dayOfMonth } = parseCalendarDay(day);

	const target = new Date(Date.UTC(year, month - 1 + months, 1));
	const targetYear = target.getUTCFullYear();
	const targetMonth = target.getUTCMonth() + 1;
	// Day 0 of the following month is the last day of this one — no leap-year table.
	const lastDayOfTargetMonth = new Date(
		Date.UTC(targetYear, targetMonth, 0),
	).getUTCDate();

	return formatDay({
		year: targetYear,
		month: targetMonth,
		day: Math.min(dayOfMonth, lastDayOfTargetMonth),
	});
}

/**
 * `day` moved by whole calendar years, which may be negative — twelve calendar
 * months, with the same end-of-month clamp as {@link addCalendarMonths}.
 *
 * The clamp only ever bites on 29 February: one year after `2028-02-29` is
 * `2029-02-28`, because 29 February 2029 does not exist. Rolling into
 * 1 March instead would move an annual date into the wrong month. Zone-free.
 */
export function addCalendarYears(day: CalendarDay, years: number): CalendarDay {
	return addCalendarMonths(day, years * 12);
}

/** Negative when `a` is earlier, zero when equal, positive when later. */
export function compareCalendarDays(a: CalendarDay, b: CalendarDay): number {
	// Zero-padded ISO days compare correctly as strings; both are parsed first so
	// a malformed value is rejected rather than silently ordered.
	parseCalendarDay(a);
	parseCalendarDay(b);

	return a < b ? -1 : a > b ? 1 : 0;
}
