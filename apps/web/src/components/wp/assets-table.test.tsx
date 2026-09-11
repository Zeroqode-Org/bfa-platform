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

import type { Asset } from "./asset-types";

/**
 * The asset table's read-side behaviour: how a row's status, occupant and dates
 * are presented, and what the screen says when there is nothing to show.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the component still runs against
 * genuine React Query state — only the transport is replaced.
 */

type ListInput = {
	page: number;
	pageSize: number;
	status?: string;
	search?: string;
};

const listFn = vi.fn();
const listCustomersFn = vi.fn();
const createFn = vi.fn();
const updateFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		customers: {
			// Read only for the add dialog's optional customer picker, and only
			// while that dialog is open.
			listCustomers: {
				queryOptions: (
					_input: undefined,
					options: Record<string, unknown>,
				) => ({
					...options,
					queryKey: ["customers", "listCustomers"],
					queryFn: () => listCustomersFn(),
				}),
			},
		},
		assets: {
			listAssets: {
				queryOptions: (input: ListInput, options: Record<string, unknown>) => ({
					...options,
					queryKey: ["assets", "listAssets", input],
					queryFn: () => listFn(input),
				}),
				queryKey: () => ["assets", "listAssets"],
			},
			getAsset: {
				queryKey: (input: { id: string }) => ["assets", "getAsset", input],
			},
			createAsset: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["assets", "createAsset"],
					mutationFn: (input: unknown) => createFn(input),
				}),
			},
			updateAsset: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["assets", "updateAsset"],
					mutationFn: (input: unknown) => updateFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { AssetsTable } = await import("./assets-table");

function asset(overrides: Partial<Asset> = {}): Asset {
	return {
		id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		bin: "BIN-10041",
		bfaType: "RP",
		make: "Watts",
		model: "909",
		serialNumber: "SN-88120",
		size: "2 in",
		serviceAddress: "18 Canal Road",
		assemblyLocation: "Meter pit",
		annualTestDate: "2027-04-01",
		assetStatus: "active",
		currentCustomerId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		currentCustomerName: "Marta Ellison",
		currentCustomerStatus: "active",
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

function page(rows: Asset[], overrides: Record<string, number> = {}) {
	return {
		rows,
		total: rows.length,
		page: 1,
		pageSize: 25,
		pageCount: 1,
		...overrides,
	};
}

function renderTable() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	render(
		<QueryClientProvider client={queryClient}>
			<AssetsTable />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listFn.mockReset();
	listCustomersFn.mockReset();
	createFn.mockReset();
	updateFn.mockReset();
	listFn.mockResolvedValue(page([asset()]));
	listCustomersFn.mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
});

describe("AssetsTable", () => {
	it("labels each status with the wording the scheduler's three states carry", async () => {
		listFn.mockResolvedValue(
			page([
				asset({ id: "a", bin: "BIN-1", assetStatus: "active" }),
				asset({ id: "b", bin: "BIN-2", assetStatus: "due_soon" }),
				asset({ id: "c", bin: "BIN-3", assetStatus: "past_due" }),
			]),
		);

		renderTable();

		expect(await screen.findByText("Active")).toBeTruthy();
		expect(screen.getByText("Due soon")).toBeTruthy();
		expect(screen.getByText("Past due")).toBeTruthy();
	});

	it("says an asset's email is paused when its occupant is suspended", async () => {
		// The consequence lives on the customer but lands on the asset, so the
		// asset row is where it has to be readable.
		listFn.mockResolvedValue(
			page([asset({ currentCustomerStatus: "suspended" })]),
		);

		renderTable();

		expect(await screen.findByText("Marta Ellison")).toBeTruthy();
		expect(screen.getByText("Suspended — email paused")).toBeTruthy();
	});

	it("calls an asset with no occupant unassigned rather than blank", async () => {
		listFn.mockResolvedValue(
			page([
				asset({
					currentCustomerId: null,
					currentCustomerName: null,
					currentCustomerStatus: null,
				}),
			]),
		);

		renderTable();

		expect(await screen.findByText("Unassigned")).toBeTruthy();
	});

	it("links a BIN to the asset's own page, where its history is", async () => {
		renderTable();

		const link = await screen.findByRole("link", { name: "BIN-10041" });
		expect(link.getAttribute("href")).toBe(
			"/wp/assets/8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		);
	});

	it("keeps link semantics on the row's View control", async () => {
		// It is a link wearing a button's styling, and it has to stay a link.
		// Rendering the anchor through Base UI's `Button` warns that it expected a
		// native <button>, and the `nativeButton={false}` escape hatch answers that
		// by shimming the anchor into one — `role="button"`, which announces the
		// wrong thing for a control that navigates and costs a pointer user
		// middle-click and open-in-new-tab. `buttonVariants` borrows the class
		// names and leaves the element alone.
		renderTable();

		const view = await screen.findByRole("link", { name: "View" });

		expect(view.tagName).toBe("A");
		expect(view.getAttribute("href")).toBe(
			"/wp/assets/8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		);
		expect(view.getAttribute("role")).toBeNull();
		expect(screen.queryByRole("button", { name: "View" })).toBeNull();
	});

	it("offers the Add button when the purveyor has no assets at all", async () => {
		listFn.mockResolvedValue(page([]));

		renderTable();

		expect(await screen.findByText("No assets yet")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: /Add asset/ }).length).toBe(2);
	});

	it("says the filters emptied the table when a search finds nothing", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		listFn.mockResolvedValue(page([]));
		fireEvent.change(
			screen.getByLabelText("Search assets by BIN or service address"),
			{ target: { value: "canal" } },
		);

		// One request per typed word, not per keystroke — the box is debounced.
		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(
				expect.objectContaining({ search: "canal" }),
			),
		);

		// A different nothing from the one above: the fix is to change the filter,
		// not to add a first asset.
		expect(
			await screen.findByText("No assets match these filters"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
	});

	it("shows the server's message and a retry when the list fails", async () => {
		listFn.mockRejectedValue(new Error("Water Purveyor only"));

		renderTable();

		expect(await screen.findByText("Couldn’t load assets")).toBeTruthy();
		expect(screen.getByText("Water Purveyor only")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});

	it("pages only when there is a second page to reach", async () => {
		listFn.mockResolvedValue(page([asset()], { total: 60, pageCount: 3 }));

		renderTable();

		expect(await screen.findByText("Page 1 of 3")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled"),
		).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Next" }));

		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })),
		);
	});

	it("fetches the customer list only once the add dialog is opened", async () => {
		listCustomersFn.mockResolvedValue([
			{ id: "customer-a", name: "Marta Ellison", status: "active" },
		]);

		renderTable();
		await screen.findByText("BIN-10041");

		// Most visits to this page never open the dialog, so the picker's list is
		// not part of loading the table.
		expect(listCustomersFn).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /Add asset/ }));

		expect(await screen.findByLabelText("Customer")).toBeTruthy();
		await waitFor(() => expect(listCustomersFn).toHaveBeenCalled());
	});
});
