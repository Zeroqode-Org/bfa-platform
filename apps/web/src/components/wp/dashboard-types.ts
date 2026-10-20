import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterOutputs } from "@trpc/server";
import type { Route } from "next";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** The five stat-card values, as the server returns them. */
export type DashboardMetrics = RouterOutputs["dashboard"]["dashboardMetrics"];

/** One month of the trailing-twelve trend. Always present, even when empty. */
export type TrendMonth =
	RouterOutputs["dashboard"]["complianceTrend"]["months"][number];

/** Pass and fail counts for the chosen window, with the window echoed back. */
export type PassFailBreakdown = RouterOutputs["dashboard"]["passFailBreakdown"];

/** One row of the incoming-reports list — the head of Submitted Tests. */
export type IncomingReport =
	RouterOutputs["dashboard"]["incomingReports"][number];

/** One row of the No-BIN table — a submitted test still waiting for a BIN. */
export type NoBinReport = RouterOutputs["dashboard"]["noBinReports"][number];

/** One past-due asset. */
export type DelinquentAsset =
	RouterOutputs["dashboard"]["delinquentAssets"][number];

/**
 * One asset on the fail list — a failure 30 or more days old with no later
 * submitted pass — with the day its failure episode began.
 */
export type FailListRow = RouterOutputs["dashboard"]["failList"][number];

/**
 * Where a row of the incoming list goes when it is clicked.
 *
 * `/wp/tests`, with the submission named in the query string — not a detail
 * route of the dashboard's own. The Submitted Tests screen opens a record in a
 * dialog over its filtered list, because a purveyor working through
 * submissions opens several in a row; that is the experience this list is a
 * preview of, so arriving from here lands in the same place with the same
 * controls and the same permissions. A parallel detail view would be a second
 * copy of the document, the corrections form and the link-to-asset flow, and
 * the two would drift.
 *
 * The id goes through `encodeURIComponent` because it reaches a URL — it is a
 * uuid from our own database today, and that is not a reason to build a URL by
 * concatenation. The `Route` assertion is the one place a cast is needed:
 * `typedRoutes` describes path shapes and has no way to say "this static route,
 * with a query string", so the alternative is not more type safety but an
 * inline literal in the JSX that no test can call.
 */
export function submittedTestHref(submissionId: string): Route {
	return `/wp/tests?test=${encodeURIComponent(submissionId)}` as Route;
}

/** Where a delinquent row goes: the asset's own detail route. */
export function assetHref(assetId: string): Route {
	return `/wp/assets/${encodeURIComponent(assetId)}` as Route;
}

/**
 * The fail-list page, reached from the Past due card. One helper rather than a
 * string literal in the card, so the card and any future caller name the same
 * route. The build plan fixes the handoff, not the URL; `/wp/fail-list` is the
 * minimal default and is documented as such.
 */
export function failListHref(): Route {
	// The same cast the other helpers make: `typedRoutes`' generated union is
	// refreshed by the Next dev server / build, so a route added in the same
	// change as its first caller does not exist in the union a bare `tsc` sees.
	return "/wp/fail-list" as Route;
}

/**
 * Number formatting for the cards.
 *
 * Grouped, so a purveyor with four thousand assets reads "4,120" rather than
 * counting digits. One formatter for every card, so two of them cannot end up
 * spelling the same size of number differently.
 */
const countFormatter = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
	return countFormatter.format(value);
}

/**
 * A rate as a percentage with at most one decimal.
 *
 * Trailing `.0` is dropped: "100%" rather than "100.0%", because the extra
 * digit implies a precision a rate over eleven tests does not have.
 */
export function formatPercent(value: number): string {
	return `${Number(value.toFixed(1))}%`;
}

const monthFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	year: "numeric",
	timeZone: "UTC",
});

const shortMonthFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	timeZone: "UTC",
});

/**
 * A `YYYY-MM` key as a `Date`, for the formatters above.
 *
 * The key carries no zone — it names a month, full stop — but `Intl` needs an
 * instant, so one is invented at a fixed point and read back at that same fixed
 * point (`timeZone: "UTC"` on every formatter here). Pinning both ends is what
 * makes the round trip lossless. Inventing the instant at UTC midnight and then
 * formatting it in the *browser's* zone would label the January point "Dec" for
 * every reader west of UTC — the whole x-axis off by one, from a value that
 * never had a zone to begin with.
 */
function monthDate(month: string): Date {
	return new Date(`${month}-01T00:00:00Z`);
}

/** "Sep 2026" — the axis tooltip and the accessible table. */
export function formatMonth(month: string): string {
	return monthFormatter.format(monthDate(month));
}

/** "Sep" — the axis tick, where twelve full labels would not fit. */
export function formatMonthShort(month: string): string {
	return shortMonthFormatter.format(monthDate(month));
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

/**
 * A `YYYY-MM-DD` column as a date a person reads, or an em dash.
 *
 * Same fixed-point round trip as the month formatters: `test_date` and
 * `annual_test_date` are Postgres `date` columns with no zone on them, so the
 * day is invented and read back at the same point rather than being pushed
 * through the reader's zone, where a test performed on the 1st would show as
 * the 31st for anyone west of UTC.
 */
export function formatDay(value: string | null): string {
	if (!value) return "—";

	return dayFormatter.format(new Date(`${value}T00:00:00Z`));
}

/**
 * Whether a string is a complete ISO calendar date the server would accept.
 *
 * A native `<input type="date">` gives back either a well-formed `YYYY-MM-DD`
 * or the empty string — and the empty string is the case that matters. Clearing
 * one of the two boxes is an ordinary thing to do on the way to typing a
 * different date, and sending `""` to `passFailBreakdown` gets it refused by
 * `z.iso.date()`. That refusal is correct, and it is the wrong thing for the
 * reader to see: a validation error arrives on screen as a failed request,
 * which says the server is broken when the truth is that a box is empty.
 *
 * So the screen asks this first and simply does not send an incomplete range.
 * The server's own check is untouched and is still the boundary — this only
 * decides whether there is a question worth asking yet.
 *
 * The round trip through `Date` is what catches a date that matches the shape
 * but is not a day: `2026-02-30` parses, rolls forward to March 2nd, and comes
 * back spelled differently. A regex alone would pass it.
 */
export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

	const parsed = new Date(`${value}T00:00:00Z`);

	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

/**
 * The default window for the pass/fail breakdown: the same trailing twelve
 * months the trend chart covers, ending today.
 *
 * Deliberately the same period as the chart beside it. Two charts on one screen
 * showing different spans of the same data is how a reader comes away with a
 * number that does not reconcile with the one above it — and the range is
 * visible and editable, so a reader who wants a different span says so.
 *
 * Computed from a `today` the *server* supplied rather than from `new Date()`
 * in the browser. A client component renders on the server first, and a default
 * derived from the clock would be computed twice, a moment apart, either side
 * of a hydration boundary.
 *
 * Pure calendar arithmetic on a `YYYY-MM-DD` string: `Date.UTC` is used here to
 * borrow JavaScript's month rollover, not because the result is an instant. The
 * two bounds it returns are calendar dates, compared against a `date` column.
 */
export function defaultBreakdownRange(today: string): {
	from: string;
	to: string;
} {
	const [year, month] = today.split("-").map(Number);

	// A negative month index rolls the year back, so December through February
	// needs no special case. Day 1, matching the trend window's first month.
	const start = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1 - 11, 1));
	const pad = (value: number) => String(value).padStart(2, "0");

	return {
		from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`,
		to: today,
	};
}

/**
 * How overdue a past-due asset is, in whole days, or `null` when it carries no
 * annual test date.
 *
 * `null` rather than `0`: an asset the scheduler marked past due but which has
 * no date to be past is a data problem, and calling it "0 days overdue" would
 * dress that up as "due today".
 *
 * Both sides are calendar days with no zone — `annual_test_date` from the
 * column, `today` decided once on the server — and both are pinned to the same
 * instant before subtracting, so the answer is a whole number of days between
 * two dates rather than a difference between two moments. No rounding, and no
 * off-by-one for a reader in a zone where it is already tomorrow.
 */
export function daysOverdue(
	annualTestDate: string | null,
	today: string,
): number | null {
	if (!annualTestDate) return null;

	const due = Date.parse(`${annualTestDate}T00:00:00Z`);
	const now = Date.parse(`${today}T00:00:00Z`);

	if (Number.isNaN(due) || Number.isNaN(now)) return null;

	const days = Math.floor((now - due) / 86_400_000);

	// The scheduler says past due and the date says otherwise — a race with a
	// just-corrected test date, most likely. Report nothing rather than a
	// negative number of days overdue.
	return days > 0 ? days : null;
}

/**
 * How long an asset has been failing, in whole days.
 *
 * Both sides are UTC calendar days — `failingSince` comes off the procedure as
 * one, `today` is decided once on the server — pinned to the same instant
 * before subtracting, exactly as {@link daysOverdue} does it. A listed row has
 * been failing at least 30 days by the server's clock, but `today` is fixed at
 * page render while the list is fetched afterwards, so a page left open
 * across midnight can compute a smaller number; it is clamped at zero rather
 * than trusted to be 30 or more.
 */
export function failingDays(failingSince: string, today: string): number {
	const since = Date.parse(`${failingSince}T00:00:00Z`);
	const now = Date.parse(`${today}T00:00:00Z`);

	if (Number.isNaN(since) || Number.isNaN(now)) return 0;

	return Math.max(0, Math.floor((now - since) / 86_400_000));
}

export type FailAgeBand = "days_30_to_60" | "over_60";

/**
 * The age bands a fail-list row can actually be in, from days since the
 * failure episode began.
 *
 * An asset reaches the list only after 30 days without a passing re-test
 * (PRD § 6.8), so the build plan's original "under 30 days" band cannot occur
 * and is not modelled. The two it keeps are the build plan's own mappings:
 * 30 to 60 days inclusive is the stronger danger tint, past 60 the full danger
 * colour. Day 61 is the first morning of the second band, so a row crossing
 * 60 days visibly changes colour.
 *
 * A figure under 30 — only possible from a `today` gone stale on a page left
 * open, see {@link failingDays} — is treated as the first band rather than
 * rendered as a state the list never shows.
 */
export function failAgeBand(days: number): FailAgeBand {
	return days > 60 ? "over_60" : "days_30_to_60";
}
