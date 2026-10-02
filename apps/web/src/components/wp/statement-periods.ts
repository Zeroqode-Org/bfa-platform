/**
 * The quick periods on the Submitted Tests screen — the statement half of that
 * screen (PRD § 6.12).
 *
 * Pure, so the calendar rules can be tested without rendering anything.
 */

/**
 * The zone the business's dates mean something in (PRD § 4, build plan
 * "Timezone"). "This month" for a Hawaii purveyor is Hawaii's month: at 3pm on
 * the 31st in Honolulu it is already the 1st in UTC, and a statement button
 * that jumped to the next month that afternoon would be wrong.
 */
const HAWAII_TIME_ZONE = "Pacific/Honolulu";

/** `YYYY-MM-DD` — `en-CA` happens to format a date in exactly that shape. */
const isoDayFormatter = new Intl.DateTimeFormat("en-CA", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	timeZone: HAWAII_TIME_ZONE,
});

/** Today's calendar day in Hawaii, as `YYYY-MM-DD`. */
export function hawaiiToday(now: Date = new Date()): string {
	return isoDayFormatter.format(now);
}

export type StatementPeriodKey = "thisMonth" | "lastMonth" | "yearToDate";

export type StatementPeriod = {
	key: StatementPeriodKey;
	label: string;
	/** Inclusive `YYYY-MM-DD` bounds, as the list and the export take them. */
	from: string;
	to: string;
};

function pad(value: number) {
	return String(value).padStart(2, "0");
}

/**
 * The three periods a purveyor reaches for, relative to `today`.
 *
 * "This month" and "Year to date" end today rather than on the last day of the
 * period — a statement cannot hold tests nobody has run yet, and a range
 * ending on the 31st would read as a promise that it covers the whole month.
 * "Last month" is the closed calendar month: the monthly statement proper.
 *
 * Calendar arithmetic on the day string, never on a `Date`, so no zone can
 * shift a boundary by one.
 */
export function statementPeriods(today: string): StatementPeriod[] {
	const [year, month] = today.split("-").map(Number) as [number, number];
	const lastMonthYear = month === 1 ? year - 1 : year;
	const lastMonth = month === 1 ? 12 : month - 1;
	// Day 0 of a month is the last day of the one before it.
	const lastMonthEnd = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();

	return [
		{
			key: "thisMonth",
			label: "This month",
			from: `${year}-${pad(month)}-01`,
			to: today,
		},
		{
			key: "lastMonth",
			label: "Last month",
			from: `${lastMonthYear}-${pad(lastMonth)}-01`,
			to: `${lastMonthYear}-${pad(lastMonth)}-${pad(lastMonthEnd)}`,
		},
		{
			key: "yearToDate",
			label: "Year to date",
			from: `${year}-01-01`,
			to: today,
		},
	];
}
