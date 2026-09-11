"use client";

import type { PassFailBreakdown, TrendMonth } from "./dashboard-types";
import {
	formatCount,
	formatMonth,
	formatMonthShort,
	formatPercent,
} from "./dashboard-types";

/**
 * The two dashboard charts, drawn as inline SVG and plain elements.
 *
 * No charting library. Nothing in the project depends on one, and the two
 * shapes here — a twelve-point line and two proportional bars — are a hundred
 * lines of arithmetic against several hundred kilobytes of runtime that would
 * also need restyling onto the design tokens before it matched anything else on
 * the screen. Adding a dependency is a decision to take when a chart needs
 * axes it can compute itself, zooming, or a legend that reflows; these do not.
 *
 * Accessibility is not the `aria-label` on the `<svg>`. Every chart here
 * carries a screen-reader table holding the same numbers the picture does, so
 * the data is readable rather than merely summarised — a one-sentence label is
 * fine for "what is this", and useless for "what was March".
 *
 * Every colour is a token class. The SVG uses Tailwind's `stroke-*` and
 * `fill-*` utilities for exactly the reason the rest of the app avoids inline
 * hex: a chart that hardcoded `#1588c1` would stop matching the day the theme
 * sheet moves.
 */

const VIEW = {
	width: 720,
	height: 240,
	padLeft: 34,
	padRight: 10,
	padTop: 12,
	padBottom: 30,
};

const PLOT_WIDTH = VIEW.width - VIEW.padLeft - VIEW.padRight;
const PLOT_HEIGHT = VIEW.height - VIEW.padTop - VIEW.padBottom;

/** The horizontal rules, as percentages. Also the y-axis tick labels. */
const GRID_LINES = [0, 25, 50, 75, 100];

function xFor(index: number, count: number): number {
	if (count <= 1) return VIEW.padLeft + PLOT_WIDTH / 2;

	return VIEW.padLeft + (index * PLOT_WIDTH) / (count - 1);
}

function yFor(rate: number): number {
	return VIEW.padTop + PLOT_HEIGHT * (1 - rate / 100);
}

/**
 * The months split into runs of consecutive tested months.
 *
 * A month nobody tested in breaks the line rather than being interpolated
 * across. Joining February to April through an empty March would draw a
 * confident straight line through a period about which the data says nothing —
 * and a reader cannot tell a drawn line from a measured one.
 */
function trendSegments(
	months: TrendMonth[],
): { index: number; rate: number }[][] {
	const segments: { index: number; rate: number }[][] = [];
	let current: { index: number; rate: number }[] = [];

	months.forEach((month, index) => {
		if (month.passRate === null) {
			if (current.length > 0) segments.push(current);
			current = [];
			return;
		}

		current.push({ index, rate: month.passRate });
	});

	if (current.length > 0) segments.push(current);

	return segments;
}

/**
 * Monthly pass rate over the trailing twelve calendar months.
 *
 * The twelve months always render, including the ones with nothing in them:
 * the axis is the calendar, and a chart that showed only the months with data
 * would silently change its own x-axis every time a purveyor had a quiet
 * period.
 */
export function ComplianceTrendChart({ months }: { months: TrendMonth[] }) {
	const segments = trendSegments(months);
	const tested = months.filter((month) => month.passRate !== null);
	const hasData = tested.length > 0;

	const summary = hasData
		? `Monthly pass rate from ${formatMonth(months[0]?.month ?? "")} to ${formatMonth(
				months[months.length - 1]?.month ?? "",
			)}. ${tested.length} of ${months.length} months have tests recorded.`
		: "Monthly pass rate over the trailing twelve months. No tests with a recorded result fall in this period.";

	return (
		<figure className="m-0 flex flex-col gap-2">
			<svg
				viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
				className="h-auto w-full"
				role="img"
				aria-label={summary}
			>
				<title>Compliance trend</title>

				{GRID_LINES.map((line) => (
					<g key={line}>
						<line
							x1={VIEW.padLeft}
							x2={VIEW.width - VIEW.padRight}
							y1={yFor(line)}
							y2={yFor(line)}
							className="stroke-border-soft"
							strokeWidth={1}
						/>
						<text
							x={VIEW.padLeft - 8}
							y={yFor(line) + 3}
							textAnchor="end"
							fontSize={10}
							className="fill-text-tertiary"
						>
							{line}%
						</text>
					</g>
				))}

				{months.map((month, index) => (
					<text
						key={month.month}
						x={xFor(index, months.length)}
						y={VIEW.height - 10}
						textAnchor="middle"
						fontSize={10}
						className="fill-muted-foreground"
					>
						{formatMonthShort(month.month)}
					</text>
				))}

				{segments.map((segment) => (
					<polyline
						key={`line-${segment[0]?.index}`}
						points={segment
							.map(
								(point) =>
									`${xFor(point.index, months.length)},${yFor(point.rate)}`,
							)
							.join(" ")}
						fill="none"
						className="stroke-primary"
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				))}

				{/* A month with exactly one tested neighbour on neither side draws no
				    polyline of its own — a one-point line has no length — so every
				    tested month also gets a dot. It is also what makes a real 0%
				    visible, which a line lying flat on the axis would not be. */}
				{months.map((month, index) =>
					month.passRate === null ? null : (
						<circle
							key={`point-${month.month}`}
							cx={xFor(index, months.length)}
							cy={yFor(month.passRate)}
							r={3.5}
							className="fill-primary"
						/>
					),
				)}

				{hasData ? null : (
					<text
						x={VIEW.padLeft + PLOT_WIDTH / 2}
						y={VIEW.padTop + PLOT_HEIGHT / 2}
						textAnchor="middle"
						fontSize={13}
						className="fill-muted-foreground"
					>
						No tests with a recorded result in the last 12 months
					</text>
				)}
			</svg>

			<figcaption className="text-[12px] text-muted-foreground">
				{hasData
					? "Pass rate per month. A month with no tested assemblies breaks the line rather than reading as 0%."
					: "Nothing to plot yet. A month appears here once a certifier files a test carrying a pass or fail."}
			</figcaption>

			{/* The same numbers, readable rather than summarised.

			    `sr-only` goes on a wrapper, never on the `<table>` itself. The
			    utility hides a box by making it 1px and absolutely positioned, and
			    an absolutely positioned box still contributes to the document's
			    scrollable overflow — but a table ignores a height smaller than its
			    own rows, so the box stayed twelve rows tall and hung below the
			    viewport, giving the page a second scrollbar next to the shell's
			    own. On a plain `<div>` the height sticks, and `overflow: hidden`
			    clips the full-height table inside it. */}
			<div className="sr-only">
				<table>
					<caption>Monthly pass rate, trailing twelve months</caption>
					<thead>
						<tr>
							<th scope="col">Month</th>
							<th scope="col">Pass rate</th>
							<th scope="col">Passed</th>
							<th scope="col">Failed</th>
						</tr>
					</thead>
					<tbody>
						{months.map((month) => (
							<tr key={month.month}>
								<th scope="row">{formatMonth(month.month)}</th>
								<td>
									{month.passRate === null
										? "No tests"
										: formatPercent(month.passRate)}
								</td>
								<td>{formatCount(month.passCount)}</td>
								<td>{formatCount(month.failCount)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</figure>
	);
}

/**
 * Pass against fail for the chosen window, as two proportional bars.
 *
 * Bars rather than a pie, and two of them rather than one stacked: the question
 * is "how many passed and how many failed", and two lengths against a common
 * baseline are the one comparison people read accurately. A zero-length bar
 * still renders its track and its `0`, because a genuine zero is a finding and
 * an absent bar looks like a chart that failed to draw.
 *
 * **The figure contains pass and fail and nothing else** — two bars, a caption
 * counting results, and a screen-reader table carrying the same two numbers.
 * That is the whole breakdown.
 *
 * `supplemental.unrecorded` is rendered by `UnrecordedNote` *outside* this
 * figure, as a sibling. A submitted test with no result recorded is a real
 * thing a purveyor should know about, but it is not a third slice of this
 * chart: inside the `<figure>` it would read as part of the breakdown — to a
 * screen reader walking the table most of all — and a reader could reasonably
 * add it to the two bars and expect the sum to mean something. Keeping it out
 * puts the distinction in the markup rather than only in the wording.
 */
export function PassFailChart({ breakdown }: { breakdown: PassFailBreakdown }) {
	const { pass, fail, total } = breakdown;

	return (
		<figure className="m-0 flex flex-col gap-3">
			<div className="flex flex-col gap-3">
				<BreakdownBar
					label="Passed"
					count={pass}
					total={total}
					fillClassName="bg-success"
					textClassName="text-success"
				/>
				<BreakdownBar
					label="Failed"
					count={fail}
					total={total}
					fillClassName="bg-danger"
					textClassName="text-danger"
				/>
			</div>

			<figcaption className="text-[12px] text-muted-foreground">
				{total === 0
					? "No pass or fail results fall in this range."
					: `${formatCount(total)} ${total === 1 ? "result" : "results"} in this range.`}
			</figcaption>

			{/* Wrapped, not `sr-only` on the table — same reason as the trend
			    table above. Two rows rather than twelve makes the overflow smaller,
			    not absent, and the two should fail the same way if either is ever
			    edited. */}
			<div className="sr-only">
				<table>
					<caption>
						Pass and fail counts from {breakdown.from} to {breakdown.to}
					</caption>
					<tbody>
						<tr>
							<th scope="row">Passed</th>
							<td>{formatCount(pass)}</td>
						</tr>
						<tr>
							<th scope="row">Failed</th>
							<td>{formatCount(fail)}</td>
						</tr>
					</tbody>
				</table>
			</div>
		</figure>
	);
}

/**
 * Submitted tests in the window that recorded no result — stated beside the
 * breakdown, and explicitly not part of it.
 *
 * Renders nothing when there are none, so the screen does not carry a standing
 * caveat about a case that is not occurring. When there are, the wording leads
 * with the exclusion: a reader who stops after the first two words has still
 * been told the right thing.
 */
export function UnrecordedNote({ count }: { count: number }) {
	if (count === 0) return null;

	return (
		<p className="border-border-soft border-t pt-3 text-[12px] text-muted-foreground">
			<span className="font-semibold">Not counted above:</span>{" "}
			{formatCount(count)} submitted {count === 1 ? "test" : "tests"} in this
			range {count === 1 ? "has" : "have"} no result recorded, so{" "}
			{count === 1 ? "it is" : "they are"} in neither bar.
		</p>
	);
}

/**
 * One bar. The percentage is of the pass/fail total, not of every row in the
 * window — the denominator is results, which is what a pass rate means.
 */
function BreakdownBar({
	label,
	count,
	total,
	fillClassName,
	textClassName,
}: {
	label: string;
	count: number;
	total: number;
	fillClassName: string;
	textClassName: string;
}) {
	const share = total === 0 ? 0 : (count / total) * 100;

	return (
		<div className="flex flex-col gap-1.5" aria-hidden="true">
			<div className="flex items-baseline justify-between gap-3">
				<span className="font-semibold text-[13px] text-foreground">
					{label}
				</span>
				<span
					className={`font-semibold text-[13px] tabular-nums ${textClassName}`}
				>
					{formatCount(count)}
					{total === 0 ? null : (
						<span className="ml-1.5 font-normal text-[12px] text-muted-foreground">
							{formatPercent(share)}
						</span>
					)}
				</span>
			</div>
			<div className="h-2.5 w-full overflow-hidden rounded-sm bg-muted">
				<div
					className={`h-full rounded-sm ${fillClassName}`}
					style={{ width: `${share}%` }}
				/>
			</div>
		</div>
	);
}
