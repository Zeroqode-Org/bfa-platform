// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FailListRow } from "./dashboard-types";

/**
 * The fail list's presentation: the three non-data states, the two reachable
 * age bands, the sorting, and where a row leads.
 *
 * Membership itself — the 30-day entry rule, who is on the list, tenant
 * isolation, episode arithmetic — is the procedure's and is asserted against
 * real Postgres in `failure-workflow.db.test.ts`. Every fixture here is
 * therefore a row the server could actually return: failing for 30 days or
 * more at `TODAY`. What this suite pins is that the screen renders what it is
 * given honestly: the server's default order untouched, the band decided by
 * age rather than by row order, and the age printed in words so colour is
 * never the only carrier.
 *
 * `today` is fixed, as in the dashboard suite: half of these assertions are
 * about day counts, and a suite reading the clock would assert something
 * different every morning.
 */

const TODAY = "2026-09-11";

const failListFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		dashboard: {
			failList: {
				queryOptions: () => ({
					queryKey: ["dashboard", "failList"],
					queryFn: () => failListFn(),
				}),
			},
		},
	},
}));

const { FailListTable } = await import("./fail-list-table");

function row(overrides: Partial<FailListRow> = {}): FailListRow {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		bin: "BIN-1",
		bfaType: "RP",
		serviceAddress: "12 Kalani Street",
		currentCustomerName: "Marta Ellison",
		failingSince: "2026-08-01",
		...overrides,
	};
}

let client: QueryClient;

function renderTable() {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	return render(
		<QueryClientProvider client={client}>
			<FailListTable today={TODAY} />
		</QueryClientProvider>,
	);
}

/** The rendered data rows, as [bin, band-carrying class list] pairs. */
function dataRows() {
	return screen
		.getAllByRole("row")
		.filter((tr) => tr.querySelector("a[href^='/wp/assets/']"));
}

beforeEach(() => {
	failListFn.mockReset();
});

afterEach(() => {
	cleanup();
	client.clear();
});

describe("FailListTable", () => {
	it("shows placeholder rows while loading", () => {
		failListFn.mockReturnValue(new Promise(() => undefined));
		renderTable();

		expect(
			document.querySelectorAll("[data-slot='skeleton']").length,
		).toBeGreaterThan(0);
	});

	it("reports a failed load and retries on demand", async () => {
		failListFn.mockRejectedValueOnce(new Error("boom"));
		failListFn.mockResolvedValueOnce([row()]);
		renderTable();

		await screen.findByText("Couldn’t load the fail list");

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		await screen.findByText("BIN-1");
	});

	it("explains the 30-day rule on an empty list rather than rendering a blank table", async () => {
		failListFn.mockResolvedValue([]);
		renderTable();

		await screen.findByText("Nothing on the fail list");
		// An empty list is not "no failures": newer failures exist and are
		// deliberately not listed yet. The copy has to say so.
		expect(
			screen.getByText(
				/once a failed test has gone 30 days without a passing re-test/,
			),
		).toBeDefined();
		expect(screen.getByText(/Newer failures are not listed yet/)).toBeDefined();
		expect(screen.getByText(/Drafts never count/)).toBeDefined();
		expect(screen.queryByText(/No failing assemblies/)).toBeNull();
	});

	it("renders one row per asset, linking to the existing asset detail route", async () => {
		failListFn.mockResolvedValue([row()]);
		renderTable();

		const link = await screen.findByRole("link", { name: "BIN-1" });

		expect(link.getAttribute("href")).toBe(
			"/wp/assets/11111111-1111-4111-8111-111111111111",
		);
	});

	it("colours each row by its reachable age band and prints the age in words", async () => {
		failListFn.mockResolvedValue([
			// 30 days — the entry morning: the stronger danger tint.
			row({
				id: "aaaaaaaa-1111-4111-8111-111111111111",
				bin: "ENTERED",
				failingSince: "2026-08-12",
			}),
			// 60 days — still the stronger tint.
			row({
				id: "bbbbbbbb-1111-4111-8111-111111111111",
				bin: "SIXTY",
				failingSince: "2026-07-13",
			}),
			// 61 days — the full danger colour.
			row({
				id: "cccccccc-1111-4111-8111-111111111111",
				bin: "OLD",
				failingSince: "2026-07-12",
			}),
		]);
		renderTable();

		await screen.findByText("ENTERED");

		const byBin = new Map(
			dataRows().map((tr) => [
				tr.querySelector("a")?.textContent,
				tr.className,
			]),
		);

		expect(byBin.get("ENTERED")).toContain("bg-danger-bg-strong");
		expect(byBin.get("SIXTY")).toContain("bg-danger-bg-strong");
		expect(byBin.get("OLD")).toMatch(/(^|\s)bg-danger(\s|$)/);
		expect(byBin.get("OLD")).not.toContain("bg-danger-bg-strong");

		// No row is ever given the base tint: an "under 30 days" band cannot
		// occur now that rows enter at day 30.
		for (const className of byBin.values()) {
			expect(className).not.toMatch(/(^|\s)bg-danger-bg(\s|$)/);
		}

		// The band is a glance aid; the age itself is printed.
		expect(screen.getByText("30 days")).toBeDefined();
		expect(screen.getByText("60 days")).toBeDefined();
		expect(screen.getByText("61 days")).toBeDefined();
	});

	it("keeps the server's oldest-first default order", async () => {
		failListFn.mockResolvedValue([
			row({
				id: "aaaaaaaa-1111-4111-8111-111111111111",
				bin: "OLDEST",
				failingSince: "2026-05-31",
			}),
			row({
				id: "bbbbbbbb-1111-4111-8111-111111111111",
				bin: "MIDDLE",
				failingSince: "2026-07-01",
			}),
			row({
				id: "cccccccc-1111-4111-8111-111111111111",
				bin: "NEWEST",
				failingSince: "2026-08-01",
			}),
		]);
		renderTable();

		await screen.findByText("OLDEST");

		expect(dataRows().map((tr) => tr.querySelector("a")?.textContent)).toEqual([
			"OLDEST",
			"MIDDLE",
			"NEWEST",
		]);

		const failingSince = screen.getByRole("columnheader", {
			name: /Failing since/,
		});

		expect(failingSince.getAttribute("aria-sort")).toBe("ascending");
	});

	it("re-sorts by another column on click, and flips on a second click", async () => {
		failListFn.mockResolvedValue([
			row({
				id: "aaaaaaaa-1111-4111-8111-111111111111",
				bin: "BBB",
				failingSince: "2026-05-31",
			}),
			row({
				id: "bbbbbbbb-1111-4111-8111-111111111111",
				bin: "AAA",
				failingSince: "2026-08-01",
			}),
		]);
		renderTable();

		await screen.findByText("AAA");

		fireEvent.click(screen.getByRole("button", { name: "BIN" }));

		await waitFor(() => {
			expect(
				dataRows().map((tr) => tr.querySelector("a")?.textContent),
			).toEqual(["AAA", "BBB"]);
		});
		expect(
			screen
				.getByRole("columnheader", { name: /BIN/ })
				.getAttribute("aria-sort"),
		).toBe("ascending");

		fireEvent.click(screen.getByRole("button", { name: "BIN" }));

		await waitFor(() => {
			expect(
				dataRows().map((tr) => tr.querySelector("a")?.textContent),
			).toEqual(["BBB", "AAA"]);
		});
		expect(
			screen
				.getByRole("columnheader", { name: /BIN/ })
				.getAttribute("aria-sort"),
		).toBe("descending");
	});

	it("says Unassigned for an asset between occupants", async () => {
		failListFn.mockResolvedValue([row({ currentCustomerName: null })]);
		renderTable();

		await screen.findByText("Unassigned");
	});
});
