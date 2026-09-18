// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	DashboardMetrics,
	DelinquentAsset,
	IncomingReport,
	PassFailBreakdown,
	TrendMonth,
} from "./dashboard-types";

/**
 * The home screen's read-side behaviour: what each panel says while it is
 * loading, when it fails, when there is genuinely nothing, and when there is.
 *
 * The tRPC module is mocked because importing it for real would give the five
 * queries a live HTTP link. `queryOptions` is a thin passthrough in the real
 * proxy too, so the component still runs against genuine React Query state —
 * only the transport is replaced.
 *
 * `today` is a fixed string rather than the clock. Half the assertions here are
 * about calendar edges — the default range, a day count, a month label — and a
 * suite reading the real date would assert something different every morning.
 *
 * Most queries are scoped to a named panel with `within`. That is not tidiness:
 * both charts carry a screen-reader table holding the same figures the picture
 * shows, so "75%" and "Passed" legitimately appear more than once on this
 * screen. Asserting globally would either fail on the ambiguity or, worse, pass
 * against the wrong panel.
 */

/** One of the dashboard's four named panels, as a screen reader sees it. */
function panel(name: string) {
	return within(screen.getByRole("region", { name }));
}

/** The five stat cards. */
function figures() {
	return panel("Key figures");
}

/**
 * The trend chart's screen-reader table, rather than the whole panel.
 *
 * The SVG's own y-axis ticks are "0%", "25%", "75%" and so on, so a rate
 * asserted against the panel could match a gridline label instead of a month.
 * The table is where the data is.
 */
function trendTable() {
	return within(panel("Compliance trend").getByRole("table"));
}

const TODAY = "2026-09-11";

const metricsFn = vi.fn();
const trendFn = vi.fn();
const incomingFn = vi.fn();
const delinquentFn = vi.fn();
const breakdownFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		dashboard: {
			dashboardMetrics: {
				queryOptions: () => ({
					queryKey: ["dashboard", "metrics"],
					queryFn: () => metricsFn(),
				}),
			},
			complianceTrend: {
				queryOptions: () => ({
					queryKey: ["dashboard", "trend"],
					queryFn: () => trendFn(),
				}),
			},
			incomingReports: {
				queryOptions: (input: unknown) => ({
					queryKey: ["dashboard", "incoming", input],
					queryFn: () => incomingFn(input),
				}),
			},
			delinquentAssets: {
				queryOptions: (input: unknown) => ({
					queryKey: ["dashboard", "delinquent", input],
					queryFn: () => delinquentFn(input),
				}),
			},
			passFailBreakdown: {
				queryOptions: (input: unknown, options: Record<string, unknown>) => ({
					...options,
					queryKey: ["dashboard", "breakdown", input],
					queryFn: () => breakdownFn(input),
				}),
			},
		},
	},
}));

const { WpDashboard } = await import("./wp-dashboard");

function metrics(overrides: Partial<DashboardMetrics> = {}): DashboardMetrics {
	return {
		totalAssets: 4120,
		testsThisMonth: 12,
		pastDue: 7,
		submittedReports: 318,
		noBinSubmissions: 3,
		month: "2026-09",
		...overrides,
	};
}

/** Twelve months ending with the current one, all empty unless filled in. */
function emptyTrend(): TrendMonth[] {
	const months = [
		"2025-10",
		"2025-11",
		"2025-12",
		"2026-01",
		"2026-02",
		"2026-03",
		"2026-04",
		"2026-05",
		"2026-06",
		"2026-07",
		"2026-08",
		"2026-09",
	];

	return months.map((month) => ({
		month,
		passCount: 0,
		failCount: 0,
		testedCount: 0,
		passRate: null,
	}));
}

function trendWith(filled: Record<string, [pass: number, fail: number]>) {
	return emptyTrend().map((month) => {
		const counts = filled[month.month];
		if (!counts) return month;

		const [passCount, failCount] = counts;
		const tested = passCount + failCount;

		return {
			...month,
			passCount,
			failCount,
			testedCount: tested,
			passRate:
				tested === 0 ? null : Math.round((passCount / tested) * 1000) / 10,
		};
	});
}

function report(overrides: Partial<IncomingReport> = {}): IncomingReport {
	return {
		id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		bfaType: "RP",
		testDate: "2026-09-01",
		testResult: "pass",
		submittedBinText: null,
		bin: "BIN-10041",
		certifierName: "Marta Ellison",
		...overrides,
	};
}

function delinquent(overrides: Partial<DelinquentAsset> = {}): DelinquentAsset {
	return {
		id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		bin: "BIN-20077",
		bfaType: "DC",
		serviceAddress: "18 Canal Road",
		annualTestDate: "2026-09-01",
		currentCustomerName: "Tomas Reyes",
		...overrides,
	};
}

function breakdown(
	overrides: Partial<PassFailBreakdown> = {},
): PassFailBreakdown {
	return {
		from: "2025-10-01",
		to: TODAY,
		pass: 30,
		fail: 10,
		total: 40,
		supplemental: { unrecorded: 0 },
		...overrides,
	};
}

/** A promise that never settles — the only honest way to hold a pending state. */
function pending() {
	return new Promise(() => {});
}

function renderDashboard() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	render(
		<QueryClientProvider client={queryClient}>
			<WpDashboard today={TODAY} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	metricsFn.mockReset().mockResolvedValue(metrics());
	trendFn
		.mockReset()
		.mockResolvedValue({ months: emptyTrend(), monthCount: 12 });
	incomingFn.mockReset().mockResolvedValue([report()]);
	delinquentFn.mockReset().mockResolvedValue([delinquent()]);
	breakdownFn.mockReset().mockResolvedValue(breakdown());
});

afterEach(() => {
	cleanup();
});

describe("WpDashboard metric cards", () => {
	it("shows nothing but placeholders until the figures arrive", () => {
		metricsFn.mockImplementation(pending);

		renderDashboard();

		// No number is better than the wrong number. A card that defaulted to 0
		// while the request was in flight would tell a purveyor they have no
		// assets.
		expect(screen.queryByText("Total assets")).toBeNull();
		expect(screen.queryByText("4,120")).toBeNull();
	});

	// The build plan's five (§ 6.4.1), not the approved prototype's six. The
	// prototype also shows Certifiers and Customers; the build plan is
	// authoritative on what this screen counts, and both already have a screen
	// of their own in the sidebar.
	it("renders exactly the five build-plan metrics", async () => {
		renderDashboard();

		for (const label of [
			"Total assets",
			"Tests this month",
			"Past due",
			"Submitted reports",
			"No-BIN submissions",
		]) {
			expect(await screen.findByText(label)).toBeTruthy();
		}

		expect(screen.queryByText("Certifiers")).toBeNull();
		expect(screen.queryByText("Customers")).toBeNull();
	});

	it("fills each card from its own field, grouped for reading", async () => {
		renderDashboard();

		expect(await screen.findByText("4,120")).toBeTruthy();
		expect(screen.getByText("12")).toBeTruthy();
		expect(screen.getByText("7")).toBeTruthy();
		expect(screen.getByText("318")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
	});

	/*
	 * The confirmed reading of the build plan's "submissions awaiting review".
	 * `test_submissions.status` is only `draft | submitted` — there is no review
	 * lifecycle — so the card counts submitted rows and is labelled for what it
	 * is. The hint is part of the answer, not decoration: without it the number
	 * reads as a queue that ought to drain, and it never will.
	 */
	it("calls the submitted count what it is, rather than a review queue", async () => {
		renderDashboard();

		expect(await screen.findByText("Submitted reports")).toBeTruthy();
		expect(screen.getByText("Filed to date — not a review queue")).toBeTruthy();
		expect(screen.queryByText("Awaiting review")).toBeNull();
	});

	// The build plan routes the fail list through this card (Workflow 3): the
	// number is the scheduler's past-due count, and the click is the door to
	// the failure-based work queue.
	it("makes the Past due card a link to the fail list, and only that card", async () => {
		renderDashboard();

		const pastDue = await figures().findByRole("link", {
			name: /Past due — open the fail list/,
		});

		expect(pastDue.getAttribute("href")).toBe("/wp/fail-list");
		// The other four cards are numbers, not doors.
		expect(figures().getAllByRole("link").length).toBe(1);
	});

	it("names the month the monthly figure was measured over", async () => {
		metricsFn.mockResolvedValue(metrics({ month: "2026-09" }));

		renderDashboard();

		expect(await figures().findByText("Sep 2026")).toBeTruthy();
	});

	it("shows a genuine zero as a zero", async () => {
		metricsFn.mockResolvedValue(
			metrics({
				totalAssets: 0,
				testsThisMonth: 0,
				pastDue: 0,
				submittedReports: 0,
				noBinSubmissions: 0,
			}),
		);

		renderDashboard();

		expect(await screen.findByText("Total assets")).toBeTruthy();
		expect(figures().getAllByText("0").length).toBe(5);
	});

	it("reports a failed figures request and offers a retry", async () => {
		metricsFn.mockRejectedValue(new Error("Water Purveyor only"));

		renderDashboard();

		expect(await screen.findByText("Couldn’t load your figures")).toBeTruthy();
		expect(screen.getByText("Water Purveyor only")).toBeTruthy();

		metricsFn.mockResolvedValue(metrics());
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(await screen.findByText("4,120")).toBeTruthy();
	});
});

describe("WpDashboard incoming reports", () => {
	// The reuse assertion. Nothing here renders a document of its own; a row is
	// a link into the Submitted Tests screen, which owns the record view, the
	// corrections form and the role check.
	it("links each row into the existing Submitted Tests screen", async () => {
		renderDashboard();

		const link = await screen.findByRole("link", { name: /BIN-10041/ });

		expect(link.getAttribute("href")).toBe(
			"/wp/tests?test=8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		);
	});

	it("shows the certifier, the test date and the result", async () => {
		renderDashboard();

		const link = await screen.findByRole("link", { name: /BIN-10041/ });

		expect(link.textContent).toContain("Marta Ellison");
		expect(link.textContent).toContain("Sep 1, 2026");
		expect(link.textContent).toContain("Pass");
	});

	it("shows what the certifier typed for a no-BIN submission, and flags it", async () => {
		incomingFn.mockResolvedValue([
			report({ bin: null, submittedBinText: "TYPED-BIN-404" }),
		]);

		renderDashboard();

		expect(await screen.findByText("TYPED-BIN-404")).toBeTruthy();
		expect(screen.getByText("Not linked to an asset")).toBeTruthy();
	});

	it("says a submission has no result rather than leaving the row blank", async () => {
		incomingFn.mockResolvedValue([report({ testResult: null })]);

		renderDashboard();

		expect(await screen.findByText("No result")).toBeTruthy();
	});

	it("explains an empty inbox, including that drafts never appear in it", async () => {
		incomingFn.mockResolvedValue([]);

		renderDashboard();

		expect(await screen.findByText("Nothing filed yet")).toBeTruthy();
		expect(screen.getByText(/Drafts never do/)).toBeTruthy();
	});

	it("reports a failed incoming request without blanking the rest of the screen", async () => {
		incomingFn.mockRejectedValue(new Error("Incoming exploded"));

		renderDashboard();

		expect(
			await screen.findByText("Couldn’t load incoming reports"),
		).toBeTruthy();
		// The other panels are independent queries and are unaffected.
		expect(screen.getByText("4,120")).toBeTruthy();
		expect(screen.getByText("BIN-20077")).toBeTruthy();
	});
});

describe("WpDashboard delinquent assets", () => {
	it("links each asset to its own detail route", async () => {
		renderDashboard();

		const link = await screen.findByRole("link", { name: /BIN-20077/ });

		expect(link.getAttribute("href")).toBe(
			"/wp/assets/1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		);
	});

	it("identifies the asset by address and occupant, not by BIN alone", async () => {
		renderDashboard();

		const link = await screen.findByRole("link", { name: /BIN-20077/ });

		expect(link.textContent).toContain("18 Canal Road");
		expect(link.textContent).toContain("Tomas Reyes");
		expect(link.textContent).toContain("Sep 1, 2026");
	});

	it("says how overdue the asset is, counted from the date on the row", async () => {
		renderDashboard();

		expect(await screen.findByText("10 days")).toBeTruthy();
	});

	it("says only past due when the asset carries no annual test date", async () => {
		delinquentFn.mockResolvedValue([delinquent({ annualTestDate: null })]);

		renderDashboard();

		// Not "0 days": an asset the scheduler marked past due with no date to be
		// past is a data problem, and a zero would read as "due today".
		expect(
			await panel("Delinquent assets").findByText("Past due"),
		).toBeTruthy();
		expect(screen.queryByText("0 days")).toBeNull();
	});

	it("says so plainly when nothing is past due", async () => {
		delinquentFn.mockResolvedValue([]);

		renderDashboard();

		expect(await screen.findByText("Nothing is past due")).toBeTruthy();
	});

	it("reports a failed delinquent request on its own panel", async () => {
		delinquentFn.mockRejectedValue(new Error("Delinquent exploded"));

		renderDashboard();

		expect(
			await screen.findByText("Couldn’t load delinquent assets"),
		).toBeTruthy();
		expect(screen.getByText("BIN-10041")).toBeTruthy();
	});
});

describe("WpDashboard compliance trend", () => {
	it("plots all twelve months, including the ones with nothing in them", async () => {
		trendFn.mockResolvedValue({
			months: trendWith({ "2026-09": [3, 1] }),
			monthCount: 12,
		});

		renderDashboard();

		// The accessible table carries the same numbers the line does — the axis
		// is the calendar, so every month is a row whether or not it has tests.
		const trend = panel("Compliance trend");
		expect(await trend.findByText("Sep 2026")).toBeTruthy();
		// Twelve months plus the header row.
		expect(trend.getAllByRole("row").length).toBe(13);
	});

	it("says a quiet month had no tests rather than a 0% pass rate", async () => {
		trendFn.mockResolvedValue({
			months: trendWith({ "2026-09": [3, 1] }),
			monthCount: 12,
		});

		renderDashboard();

		await panel("Compliance trend").findByRole("table");
		const trend = trendTable();

		expect(trend.getByText("75%")).toBeTruthy();
		// Eleven empty months, each reported as having no tests — not as a month
		// in which everything failed.
		expect(trend.getAllByText("No tests").length).toBe(11);
		expect(trend.queryByText("0%")).toBeNull();
	});

	it("plots a real 0% for a month in which everything failed", async () => {
		trendFn.mockResolvedValue({
			months: trendWith({ "2026-08": [0, 4] }),
			monthCount: 12,
		});

		renderDashboard();

		await panel("Compliance trend").findByRole("table");
		expect(trendTable().getByText("0%")).toBeTruthy();
	});

	it("says so, in the chart and to a screen reader, when there is nothing at all", async () => {
		renderDashboard();

		expect(
			await screen.findByText(
				"No tests with a recorded result in the last 12 months",
			),
		).toBeTruthy();

		const chart = screen.getByRole("img", { name: /Monthly pass rate/ });
		expect(chart.getAttribute("aria-label")).toContain(
			"No tests with a recorded result",
		);
	});

	it("reports a failed trend request on its own panel", async () => {
		trendFn.mockRejectedValue(new Error("Trend exploded"));

		renderDashboard();

		expect(
			await screen.findByText("Couldn’t load the compliance trend"),
		).toBeTruthy();
		expect(screen.getByText("4,120")).toBeTruthy();
	});
});

/*
 * Both charts publish their figures as a real table for screen readers, and
 * both hide that table with `sr-only` on a *wrapper* rather than on the
 * `<table>`.
 *
 * The distinction is not cosmetic. `sr-only` hides a box by shrinking it to 1px
 * and taking it out of flow, and an absolutely positioned box still contributes
 * to the document's scrollable overflow — but a table ignores a height smaller
 * than its own rows, so the twelve-row trend table stayed ~280px tall, hung
 * below the viewport, and gave the page a second scrollbar beside the shell's.
 * On a plain `<div>` the 1px height sticks and `overflow: hidden` clips the
 * table inside it.
 *
 * jsdom does no layout, so these cannot measure the scrollbar — they pin the
 * shape that fixes it, which is what a later edit would undo. The height itself
 * is checked in a real browser.
 */
describe("WpDashboard screen-reader tables", () => {
	it("hides the trend table with a wrapper, not by styling the table", async () => {
		trendFn.mockResolvedValue({
			months: trendWith({ "2026-09": [3, 1] }),
			monthCount: 12,
		});

		renderDashboard();

		const table = await panel("Compliance trend").findByRole("table");

		expect(table.className).not.toContain("sr-only");
		expect(table.parentElement?.className).toContain("sr-only");
	});

	it("hides the breakdown table the same way", async () => {
		renderDashboard();

		const table = await panel("Pass / fail breakdown").findByRole("table");

		expect(table.className).not.toContain("sr-only");
		expect(table.parentElement?.className).toContain("sr-only");
	});

	// Hidden from sight, not from the accessibility tree — `sr-only` is the
	// whole point, and `display: none` or `aria-hidden` would silently pass the
	// scrollbar fix while deleting the data these tables exist to publish.
	it("leaves both tables readable, with their captions and headers intact", async () => {
		trendFn.mockResolvedValue({
			months: trendWith({ "2026-09": [3, 1] }),
			monthCount: 12,
		});

		renderDashboard();

		const trend = within(await panel("Compliance trend").findByRole("table"));
		expect(
			trend.getByText("Monthly pass rate, trailing twelve months"),
		).toBeTruthy();
		expect(trend.getByRole("columnheader", { name: "Month" })).toBeTruthy();
		expect(trend.getByRole("rowheader", { name: "Sep 2026" })).toBeTruthy();
		expect(trend.getAllByRole("row").length).toBe(13);

		const bars = within(panel("Pass / fail breakdown").getByRole("table"));
		expect(bars.getByRole("rowheader", { name: "Passed" })).toBeTruthy();
		expect(bars.getByRole("rowheader", { name: "Failed" })).toBeTruthy();
	});
});

describe("WpDashboard pass/fail breakdown", () => {
	it("opens on the same trailing twelve months the trend covers", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalled());

		expect(breakdownFn).toHaveBeenCalledWith({
			from: "2025-10-01",
			to: TODAY,
		});
		expect(
			(screen.getByLabelText("Tested from") as HTMLInputElement).value,
		).toBe("10/01/2025");
		// The boxes show the confirmed MM/DD/YYYY format; the request carries ISO.
		expect((screen.getByLabelText("Tested to") as HTMLInputElement).value).toBe(
			"09/11/2026",
		);
	});

	it("reports a date that is not a real day under its own box, and sends nothing", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		const from = screen.getByLabelText("Tested from");
		fireEvent.change(from, { target: { value: "02/30/2026" } });
		fireEvent.blur(from);

		const message = await screen.findByText(
			"Please enter a valid date in MM/DD/YYYY format.",
		);
		expect(from.getAttribute("aria-invalid")).toBe("true");
		expect(from.getAttribute("aria-describedby")).toBe(message.id);
		expect(breakdownFn).toHaveBeenCalledTimes(1);
	});

	it("shows the counts and each share of the results", async () => {
		renderDashboard();

		const bars = panel("Pass / fail breakdown");
		// Twice each: once on the bar, once in the screen-reader table beside it.
		expect((await bars.findAllByText("30")).length).toBe(2);
		expect(bars.getAllByText("10").length).toBe(2);
		expect(bars.getByText("75%")).toBeTruthy();
		expect(bars.getByText("25%")).toBeTruthy();
	});

	it("re-queries with the range the reader chose, and keeps the inputs in step", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalled());

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "06/01/2026" },
		});

		await waitFor(() =>
			expect(breakdownFn).toHaveBeenCalledWith({
				from: "2026-06-01",
				to: TODAY,
			}),
		);

		expect(
			(screen.getByLabelText("Tested from") as HTMLInputElement).value,
		).toBe("06/01/2026");
	});

	it("puts the range back to the last twelve months on request", async () => {
		renderDashboard();

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "06/01/2026" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Last 12 months" }));

		await waitFor(() =>
			expect(
				(screen.getByLabelText("Tested from") as HTMLInputElement).value,
			).toBe("10/01/2025"),
		);
	});

	/*
	 * Clearing a date box is an ordinary step on the way to typing a different
	 * one, and a native date input reports it as `""`. The server refuses that —
	 * correctly — but a refusal reaches the screen as a failed request, which
	 * would tell the reader something is broken while they are mid-edit. So the
	 * incomplete range is caught here and simply not sent.
	 */
	it("says which box is empty when the start date is cleared, and sends nothing", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "" },
		});

		expect(await screen.findByText("Pick a start date")).toBeTruthy();
		expect(breakdownFn).toHaveBeenCalledTimes(1);
	});

	it("says which box is empty when the end date is cleared, and sends nothing", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "" },
		});

		expect(await screen.findByText("Pick an end date")).toBeTruthy();
		expect(breakdownFn).toHaveBeenCalledTimes(1);
	});

	it("asks for both when both are cleared", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "" },
		});
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "" },
		});

		expect(await screen.findByText("Pick both dates")).toBeTruthy();
		expect(breakdownFn).toHaveBeenCalledTimes(1);
	});

	// The point of catching it locally: an empty box must not look like an
	// outage. Neither the error panel nor a stale zero may appear.
	it("shows no request failure for an incomplete range", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "" },
		});

		await screen.findByText("Pick a start date");

		expect(screen.queryByText("Couldn’t load the breakdown")).toBeNull();
		expect(
			screen.queryByText("No pass or fail results fall in this range."),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("picks the query back up the moment a valid date is typed in again", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "" },
		});
		await screen.findByText("Pick a start date");

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "06/01/2026" },
		});

		// No button to press — refilling the box is what re-enables it.
		await waitFor(() =>
			expect(breakdownFn).toHaveBeenCalledWith({
				from: "2026-06-01",
				to: TODAY,
			}),
		);
		expect(screen.queryByText("Pick a start date")).toBeNull();
		expect(await panel("Pass / fail breakdown").findByText("75%")).toBeTruthy();
	});

	it("restores a sendable range from the Last 12 months button after a box is cleared", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "" },
		});
		await screen.findByText("Pick an end date");

		fireEvent.click(screen.getByRole("button", { name: "Last 12 months" }));

		await waitFor(() =>
			expect(breakdownFn).toHaveBeenCalledWith({
				from: "2025-10-01",
				to: TODAY,
			}),
		);
		expect(screen.queryByText("Pick an end date")).toBeNull();
	});

	// The two unusable states stay distinct: an empty box is not a typo, and
	// telling somebody their range runs backwards while one end is blank would
	// send them looking at the wrong thing.
	it("does not call an incomplete range backwards", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "" },
		});

		expect(await screen.findByText("Pick an end date")).toBeTruthy();
		expect(screen.queryByText("That date range runs backwards")).toBeNull();
	});

	it("refuses a backwards range on screen rather than as a failed request", async () => {
		renderDashboard();

		await waitFor(() => expect(breakdownFn).toHaveBeenCalledTimes(1));

		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "01/01/2025" },
		});

		expect(
			await screen.findByText("That date range runs backwards"),
		).toBeTruthy();

		// And the end box itself says so once the reader leaves it.
		fireEvent.blur(screen.getByLabelText("Tested to"));
		expect(
			screen.getByText("Must be on or after the start date."),
		).toBeTruthy();
		// The server would refuse it too. Not sending it keeps a typo from
		// reading as an outage.
		expect(breakdownFn).toHaveBeenCalledTimes(1);
	});

	/*
	 * The distinction this panel exists to hold: an empty answer is a finding,
	 * and a pending or failed one is not. A zero total still draws both bars and
	 * says what it means, rather than being replaced by a placeholder that looks
	 * like the request never happened.
	 */
	it("shows a genuine zero as a result, not as an empty state", async () => {
		breakdownFn.mockResolvedValue(breakdown({ pass: 0, fail: 0, total: 0 }));

		renderDashboard();

		const bars = panel("Pass / fail breakdown");
		expect(
			await bars.findByText("No pass or fail results fall in this range."),
		).toBeTruthy();
		// Both bars are still drawn — an absent bar looks like a chart that failed
		// to render, and a real zero is a finding.
		expect(bars.getAllByText("Passed").length).toBe(2);
		expect(bars.getAllByText("Failed").length).toBe(2);
	});

	/*
	 * `unrecorded` is supplemental on the response and a sibling of the chart on
	 * screen — never a third bar and never inside `total`. These three
	 * assertions are what hold that line: the note is outside the `<figure>`,
	 * the chart's own screen-reader table lists two rows and not three, and
	 * `total` is still pass plus fail.
	 */
	it("states an unrecorded count beside the breakdown, not inside it", async () => {
		breakdownFn.mockResolvedValue(
			breakdown({
				pass: 2,
				fail: 1,
				total: 3,
				supplemental: { unrecorded: 4 },
			}),
		);

		renderDashboard();

		const note = await screen.findByText(/4 submitted tests in this range/);
		expect(note.textContent).toContain("Not counted above");
		// Outside the figure: a reader walking the chart does not meet it as part
		// of the breakdown.
		expect(note.closest("figure")).toBeNull();
	});

	it("keeps the chart's own table to pass and fail only", async () => {
		breakdownFn.mockResolvedValue(
			breakdown({
				pass: 2,
				fail: 1,
				total: 3,
				supplemental: { unrecorded: 4 },
			}),
		);

		renderDashboard();

		await screen.findByText(/4 submitted tests in this range/);
		const chartTable = within(
			panel("Pass / fail breakdown").getByRole("table"),
		);

		expect(chartTable.getAllByRole("row").length).toBe(2);
		expect(chartTable.queryByText("No result recorded")).toBeNull();
	});

	it("says nothing at all when every test in the range recorded a result", async () => {
		renderDashboard();

		await panel("Pass / fail breakdown").findByText("75%");
		expect(screen.queryByText(/Not counted above/)).toBeNull();
	});

	it("reports a failed breakdown request without claiming zero results", async () => {
		breakdownFn.mockRejectedValue(new Error("Breakdown exploded"));

		renderDashboard();

		expect(await screen.findByText("Couldn’t load the breakdown")).toBeTruthy();
		expect(
			screen.queryByText("No pass or fail results fall in this range."),
		).toBeNull();
	});
});
