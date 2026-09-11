// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepairCompany } from "./repair-company-types";

/**
 * The read-only repair-company list on the notices screen.
 *
 * What is worth asserting here is what is *absent*: this is the same data as
 * `/wp/repair-companies` and none of that screen's management controls. The
 * list is here because a failure notice names it, not so it can be edited in a
 * second place.
 */

const listFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		repairCompanies: {
			listRepairCompanies: {
				queryOptions: () => ({
					queryKey: ["repairCompanies", "listRepairCompanies"],
					queryFn: () => listFn(),
				}),
			},
		},
	},
}));

const { NoticeRepairCompanies } = await import("./notice-repair-companies");

const active: RepairCompany = {
	id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
	companyName: "Alpine Backflow Repair",
	phone: "555-0142",
	email: "dispatch@alpine.example",
	status: "active",
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as RepairCompany;

const inactive: RepairCompany = {
	...active,
	id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
	companyName: "Valley Assembly Service",
	phone: null,
	email: null,
	status: "inactive",
} as unknown as RepairCompany;

function renderList() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	render(
		<QueryClientProvider client={queryClient}>
			<NoticeRepairCompanies />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listFn.mockReset();
	listFn.mockResolvedValue([active, inactive]);
});

afterEach(() => {
	cleanup();
});

describe("NoticeRepairCompanies", () => {
	it("shows a loading state before the list arrives", () => {
		listFn.mockReturnValue(new Promise(() => {}));
		renderList();

		expect(screen.queryByText("Alpine Backflow Repair")).toBeNull();
		expect(screen.getByText("Company")).toBeTruthy();
	});

	it("lists the purveyor's companies with their contact details", async () => {
		renderList();

		expect(await screen.findByText("Alpine Backflow Repair")).toBeTruthy();
		expect(screen.getByText("dispatch@alpine.example")).toBeTruthy();
		expect(screen.getAllByText("—")).toHaveLength(2);
	});

	it("spells out what an inactive company means for a notice", async () => {
		renderList();

		expect(await screen.findByText("Not in failure notices")).toBeTruthy();
	});

	it("offers no management controls — those live on their own screen", async () => {
		renderList();

		await screen.findByText("Alpine Backflow Repair");

		for (const label of [
			/add repair company/i,
			/^edit$/i,
			/deactivate/i,
			/reactivate/i,
			/delete/i,
		]) {
			expect(screen.queryByRole("button", { name: label })).toBeNull();
		}
		// …and points at the screen that has them.
		expect(screen.getByRole("link", { name: "Repair Companies" })).toBeTruthy();
	});

	it("reports a load failure and offers a retry", async () => {
		listFn.mockRejectedValue(new Error("network is down"));
		renderList();

		expect(
			await screen.findByText(/couldn’t load repair companies/i),
		).toBeTruthy();
		expect(screen.getByText("network is down")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});

	it("says what an empty list costs, rather than showing a blank table", async () => {
		listFn.mockResolvedValue([]);
		renderList();

		expect(await screen.findByText("No repair companies yet")).toBeTruthy();
		expect(screen.getByText(/nowhere to send the customer/i)).toBeTruthy();
	});

	it("keeps link semantics on the empty state's call to action", async () => {
		// It is a link wearing a button's styling. Rendering an anchor through
		// Base UI's Button without `nativeButton={false}` leaves native button
		// semantics on it — which breaks middle-click and open-in-new-tab for a
		// pointer user and announces the wrong role to a screen reader. The
		// primitive warns about exactly that, so the link role here and the
		// absence of the warning are the same fact.
		listFn.mockResolvedValue([]);
		renderList();

		const cta = await screen.findByRole("link", {
			name: /go to repair companies/i,
		});

		expect(cta.tagName).toBe("A");
		expect(cta.getAttribute("href")).toBe("/wp/repair-companies");
		expect(
			screen.queryByRole("button", { name: /go to repair companies/i }),
		).toBeNull();
	});
});
