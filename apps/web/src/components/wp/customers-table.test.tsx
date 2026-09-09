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
