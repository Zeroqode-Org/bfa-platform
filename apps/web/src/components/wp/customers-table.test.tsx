// @vitest-environment jsdom

import { CUSTOMER_EMAIL_TAKEN_MESSAGE } from "@bfa-platform/api/lib/email-uniqueness";
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

import type { Customer } from "./customer-types";

/**
 * The customer table's suspend and reactivate controls — the two actions that
 * decide whether a customer's assets keep receiving automated email.
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
		customers: {
			listCustomers: {
				queryOptions: () => ({
					queryKey: ["customers", "listCustomers"],
					queryFn: () => listFn(),
				}),
				queryKey: () => ["customers", "listCustomers"],
			},
			createCustomer: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["customers", "createCustomer"],
					mutationFn: (input: unknown) => createFn(input),
				}),
			},
			updateCustomer: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["customers", "updateCustomer"],
					mutationFn: (input: unknown) => updateFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { CustomersTable } = await import("./customers-table");

const active: Customer = {
	id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
	name: "Marta Ellison",
	accountNumber: "AC-4471",
	email: "marta@example.com",
	address: "12 Canal Road",
	rateCategory: "standard",
	agRenewalDate: null,
	status: "active",
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
};

const suspendedAgricultural: Customer = {
	...active,
	id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
	name: "Ridgeline Orchards",
	accountNumber: null,
	email: "billing@ridgeline.example",
	address: null,
	rateCategory: "agricultural",
	agRenewalDate: "2027-03-01",
	status: "suspended",
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
			<CustomersTable />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listFn.mockReset();
	updateFn.mockReset();
	createFn.mockReset();
	listFn.mockResolvedValue([active, suspendedAgricultural]);
	updateFn.mockImplementation((input: Customer) => Promise.resolve(input));
});

afterEach(() => {
	cleanup();
});

describe("CustomersTable", () => {
	it("labels the rate category and spells out what a suspended status means", async () => {
		renderTable();

		expect(await screen.findByText("Agricultural")).toBeTruthy();
		expect(screen.getByText("Standard")).toBeTruthy();
		// "Suspended" on its own leaves the consequence to be guessed at.
		expect(screen.getByText("Automated email paused")).toBeTruthy();
	});

	it("asks before suspending, and says what suspension does", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));

		expect(
			(await screen.findByText(/pauses all automated email/i)).textContent,
		).toContain("currently assigned assets");
		// Nothing has been sent yet — the dialog is a question, not a progress bar.
		expect(updateFn).not.toHaveBeenCalled();
	});

	it("sends the whole record with the status flipped once suspension is confirmed", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Suspend customer" }),
		);

		await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
		expect(updateFn).toHaveBeenCalledWith({
			id: active.id,
			name: active.name,
			email: active.email,
			accountNumber: active.accountNumber,
			address: active.address,
			rateCategory: "standard",
			agRenewalDate: null,
			status: "suspended",
		});
	});

	it("reactivates without a confirmation — restoring email is not the destructive direction", async () => {
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));

		await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
		expect(updateFn).toHaveBeenCalledWith(
			expect.objectContaining({
				id: suspendedAgricultural.id,
				status: "active",
				// The agricultural rate keeps its renewal date through a status flip.
				rateCategory: "agricultural",
				agRenewalDate: "2027-03-01",
			}),
		);
	});

	it("does not report a form save as a suspension in progress", async () => {
		// Regression: the dialog's save and the row's Suspend button both call
		// `updateCustomer`. Sharing one mutation instance between them made an
		// in-flight edit relabel that row's Suspend button as "Suspending…" —
		// telling the person their customer was being suspended when they had
		// only renamed them.
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
		// …and the row's status button says nothing at all. Queried by text, not
		// by role: the open dialog takes the row out of the accessibility tree,
		// but the label is still what the person sees behind the backdrop, and
		// the label is the whole bug.
		expect(screen.getByText("Suspend")).toBeTruthy();
		expect(screen.queryByText("Suspending…")).toBeNull();

		await act(async () => {
			release?.({ ...active, name: "Renamed" });
		});
	});

	it("bounds the add customer dialog and scrolls its fields, not itself", async () => {
		// The form is taller than a short laptop screen, and the dialog is
		// vertically centred: without a height bound its footer sat below the
		// bottom of the window, so Cancel and Add customer could not be clicked at
		// all. The classes below are the fix, and they only work together — the
		// popup is capped and clips, and a single region inside it scrolls.
		//
		// jsdom lays nothing out, so this asserts the contract rather than the
		// pixels; the rendered result is checked by hand in a short viewport.
		renderTable();

		fireEvent.click(screen.getAllByRole("button", { name: "Add customer" })[0]);

		await screen.findByLabelText("Name");

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

	it("keeps every control of the add customer dialog inside the dialog element", async () => {
		// Reachability is what the height bound is for. Base UI traps focus in the
		// popup, so a control that is not a descendant of it is a control Tab can
		// never get to — which is what the clipped footer amounted to.
		renderTable();

		fireEvent.click(screen.getAllByRole("button", { name: "Add customer" })[0]);

		await screen.findByLabelText("Name");

		const dialog = await screen.findByRole("dialog");

		for (const name of ["Cancel", "Add customer", "Close"]) {
			expect(dialog.contains(screen.getByRole("button", { name }))).toBe(true);
		}

		expect(dialog.textContent).toContain("Add customer");
	});

	it("gives the edit customer dialog the same pinned structure", async () => {
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

		expect(dialog.textContent).toContain("Edit customer");
	});

	it("shows a duplicate email refusal under Email in the open dialog, never as a toast", async () => {
		const { toast } = await import("sonner");
		vi.mocked(toast.error).mockClear();
		createFn.mockRejectedValue(
			Object.assign(new Error(CUSTOMER_EMAIL_TAKEN_MESSAGE), {
				data: { code: "CONFLICT" },
			}),
		);
		renderTable();

		fireEvent.click(screen.getAllByRole("button", { name: "Add customer" })[0]);
		fireEvent.change(await screen.findByLabelText("Name"), {
			target: { value: "Marta Ellison Two" },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "MARTA@example.com" },
		});
		for (const [label, option] of [
			["Rate category", "Standard"],
			["Status", "Active"],
		] as const) {
			fireEvent.click(screen.getByLabelText(label));
			const item = screen.getByRole("option", { name: option });
			fireEvent.pointerDown(item);
			fireEvent.pointerUp(item);
			fireEvent.click(item);
		}
		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		const message = await screen.findByText(CUSTOMER_EMAIL_TAKEN_MESSAGE);
		const email = screen.getByLabelText("Email");

		expect(createFn).toHaveBeenCalledWith(
			expect.objectContaining({ rateCategory: "standard", status: "active" }),
		);
		expect(message.getAttribute("data-slot")).toBe("field-error");
		expect(email.getAttribute("aria-invalid")).toBe("true");
		expect(email.getAttribute("aria-describedby")).toContain(message.id);
		// Still open, still correctable, and nothing popped up somewhere else.
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("offers a way to add the first customer when there are none", async () => {
		listFn.mockResolvedValue([]);
		renderTable();

		expect(await screen.findByText("No customers yet")).toBeTruthy();
	});

	it("shows the server's message and a retry when the list fails to load", async () => {
		listFn.mockRejectedValue(new Error("Water Purveyor only"));
		renderTable();

		expect(await screen.findByText("Water Purveyor only")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});
});
