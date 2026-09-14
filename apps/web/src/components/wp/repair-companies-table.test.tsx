// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepairCompany } from "./repair-company-types";

/**
 * The repair-company table's deactivate and reactivate controls — the two
 * actions that decide whether a company appears in the next failure notice.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the component still runs against
 * genuine React Query state — only the transport is replaced.
 */

const listFn = vi.fn();
const updateFn = vi.fn();
const createFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		repairCompanies: {
			listRepairCompanies: {
				queryOptions: () => ({
					queryKey: ["repairCompanies", "listRepairCompanies"],
					queryFn: () => listFn(),
				}),
				queryKey: () => ["repairCompanies", "listRepairCompanies"],
			},
			createRepairCompany: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["repairCompanies", "createRepairCompany"],
					mutationFn: (input: unknown) => createFn(input),
				}),
			},
			updateRepairCompany: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["repairCompanies", "updateRepairCompany"],
					mutationFn: (input: unknown) => updateFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { RepairCompaniesTable } = await import("./repair-companies-table");

const active: RepairCompany = {
	id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
	companyName: "Alpine Backflow Repair",
	// A valid US number: the form refuses to save any other, so a fixture that
	// is edited and saved has to carry one.
	phone: "(555) 014-2233",
	email: "dispatch@alpine.example",
	status: "active",
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
};

const inactive: RepairCompany = {
	...active,
	id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
	companyName: "Valley Assembly Service",
	phone: null,
	email: null,
	status: "inactive",
};

function renderTable() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	render(
		<QueryClientProvider client={queryClient}>
			<RepairCompaniesTable />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listFn.mockReset();
	updateFn.mockReset();
	createFn.mockReset();
	listFn.mockResolvedValue([active, inactive]);
	updateFn.mockImplementation((input: RepairCompany) => Promise.resolve(input));
	createFn.mockImplementation((input: RepairCompany) => Promise.resolve(input));
});

afterEach(() => {
	cleanup();
});

describe("RepairCompaniesTable", () => {
	it("lists inactive companies alongside active ones, so they can still be edited", async () => {
		renderTable();

		expect(await screen.findByText("Alpine Backflow Repair")).toBeTruthy();
		expect(screen.getByText("Valley Assembly Service")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
	});

	it("spells out what an inactive status means", async () => {
		renderTable();

		expect(await screen.findByText("Inactive")).toBeTruthy();
		// "Inactive" on its own leaves the consequence to be guessed at.
		expect(screen.getByText("Not in failure notices")).toBeTruthy();
	});

	it("shows a dash rather than a blank cell for a missing contact detail", async () => {
		renderTable();

		await screen.findByText("Valley Assembly Service");
		expect(screen.getAllByText("—")).toHaveLength(2);
	});

	it("offers no way to delete a company", async () => {
		renderTable();

		await screen.findByText("Alpine Backflow Repair");
		expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
	});

	it("asks before deactivating, and says what deactivation does", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));

		expect(
			await screen.findByText(/stops it appearing in future failure notices/i),
		).toBeTruthy();
		// Nothing has been sent yet — the dialog is a question, not a progress bar.
		expect(updateFn).not.toHaveBeenCalled();
	});

	it("sends the whole record with the status flipped once deactivation is confirmed", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Deactivate company" }),
		);

		await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
		expect(updateFn).toHaveBeenCalledWith({
			id: active.id,
			companyName: active.companyName,
			phone: active.phone,
			email: active.email,
			status: "inactive",
		});
	});

	it("reactivates without a confirmation — putting a company back is not the destructive direction", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));

		await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
		expect(updateFn).toHaveBeenCalledWith({
			id: inactive.id,
			companyName: inactive.companyName,
			// Absent contact details stay absent through a status flip.
			phone: null,
			email: null,
			status: "active",
		});
	});

	it("never sends a water purveyor with a status change", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));

		await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
		expect(Object.keys(updateFn.mock.calls[0][0])).not.toContain(
			"waterPurveyorId",
		);
	});

	it("does not report a form save as a deactivation in progress", async () => {
		// The dialog's save and the row's Deactivate button both call
		// `updateRepairCompany`. Sharing one mutation instance between them would
		// make an in-flight edit relabel that row's button as "Deactivating…" —
		// telling the person their company was being dropped from failure notices
		// when they had only renamed it.
		let release: ((value: unknown) => void) | undefined;
		updateFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		renderTable();

		fireEvent.click(
			(await screen.findAllByRole("button", { name: "Edit" }))[0],
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Save changes" }),
		);

		// The form says what it is doing…
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy(),
		);
		// …and the row's status button says nothing at all. Queried by text, not by
		// role: the open dialog takes the row out of the accessibility tree, but
		// the label is still what the person sees behind the backdrop.
		expect(screen.getByText("Deactivate")).toBeTruthy();
		expect(screen.queryByText("Deactivating…")).toBeNull();

		await act(async () => {
			release?.({ ...active, companyName: "Renamed" });
		});
	});

	it("bounds the add repair company dialog and scrolls its fields, not itself", async () => {
		// The form is taller than a short laptop screen, and the dialog is
		// vertically centred: without a height bound its footer sat below the
		// bottom of the window, so Cancel and Add company could not be clicked at
		// all. The classes below are the fix, and they only work together — the
		// popup is capped and clips, and a single region inside it scrolls.
		//
		// jsdom lays nothing out, so this asserts the contract rather than the
		// pixels; the rendered result is checked by hand in a short viewport.
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: /add repair company/i }),
		);

		await screen.findByLabelText("Company name");

		const dialog = await screen.findByRole("dialog");

		// `svh`, not `vh`: on a phone `vh` measures the viewport as though the
		// browser chrome were not there, which is how a dialog "inside the
		// viewport" still ends up under the address bar.
		expect(dialog.className).toContain("max-h-[calc(100svh-2rem)]");
		// The popup clips. Were it to scroll as well, the footer would ride down
		// with the fields and be back off the screen.
		expect(dialog.className).toContain("overflow-hidden");
		expect(dialog.className).not.toContain("overflow-y-auto");

		const body = dialog.querySelector('[data-slot="dialog-body"]');
		const header = dialog.querySelector('[data-slot="dialog-header"]');
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');

		expect(body).not.toBeNull();
		// `min-h-0` is the whole trick: a flex child will not shrink below its
		// content without it, so the fields would push the footer out however the
		// popup were capped.
		expect(body?.className).toContain("min-h-0");
		expect(body?.className).toContain("overflow-y-auto");
		expect(header?.className).toContain("shrink-0");
		expect(footer?.className).toContain("shrink-0");

		// The footer is inside the popup but outside the region that moves.
		expect(body?.contains(footer)).toBe(false);
	});

	it("keeps every control of the add repair company dialog inside the dialog element", async () => {
		// Reachability is what the height bound is for. Base UI traps focus in the
		// popup, so a control that is not a descendant of it is a control Tab can
		// never get to — which is what the clipped footer amounted to.
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: /add repair company/i }),
		);

		await screen.findByLabelText("Company name");

		const dialog = await screen.findByRole("dialog");

		for (const name of ["Cancel", "Add company", "Close"]) {
			expect(dialog.contains(screen.getByRole("button", { name }))).toBe(true);
		}

		expect(dialog.textContent).toContain("Add repair company");
	});

	it("gives the edit repair company dialog the same pinned structure", async () => {
		// Add and edit share one dialog and one form, so the bound has to hold for
		// the record that is longer — an existing row arrives with every optional
		// field filled in.
		renderTable();

		fireEvent.click(
			(await screen.findAllByRole("button", { name: "Edit" }))[0],
		);

		const dialog = await screen.findByRole("dialog");

		expect(dialog.className).toContain("max-h-[calc(100svh-2rem)]");
		expect(dialog.className).toContain("overflow-hidden");

		const body = dialog.querySelector('[data-slot="dialog-body"]');
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');

		expect(body?.className).toContain("min-h-0");
		expect(body?.className).toContain("overflow-y-auto");
		expect(body?.contains(footer)).toBe(false);

		for (const name of ["Cancel", "Save changes", "Close"]) {
			expect(dialog.contains(screen.getByRole("button", { name }))).toBe(true);
		}

		expect(dialog.textContent).toContain("Edit repair company");
	});

	it("creates a company without naming a tenant", async () => {
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: /add repair company/i }),
		);
		fireEvent.change(await screen.findByLabelText("Company name"), {
			target: { value: "New Repairs" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add company" }));

		await waitFor(() => expect(createFn).toHaveBeenCalledTimes(1));
		expect(createFn).toHaveBeenCalledWith({
			companyName: "New Repairs",
			phone: null,
			email: null,
			status: "active",
		});
	});

	it("keeps the dialog open and shows the message inline when a save fails", async () => {
		updateFn.mockRejectedValue(new Error("Repair company not found"));
		renderTable();

		fireEvent.click(
			(await screen.findAllByRole("button", { name: "Edit" }))[0],
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Save changes" }),
		);

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Repair company not found",
		);
		// The fields are still there to correct, which is the point of not closing.
		expect(screen.getByLabelText("Company name")).toBeTruthy();
	});

	it("offers a way to add the first company when there are none", async () => {
		listFn.mockResolvedValue([]);
		renderTable();

		expect(await screen.findByText("No repair companies yet")).toBeTruthy();
	});

	it("shows the server's message and a retry when the list fails to load", async () => {
		listFn.mockRejectedValue(new Error("Water Purveyor only"));
		renderTable();

		expect(await screen.findByText("Water Purveyor only")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});
});
