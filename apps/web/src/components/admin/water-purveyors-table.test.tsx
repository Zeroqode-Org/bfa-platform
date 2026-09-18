// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The WP list's Impersonate action: what it sends, what it shows while the
 * server is deciding, and what happens when the server refuses.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the component still runs against
 * genuine React Query state — only the transport is replaced. The navigation
 * helper is mocked because jsdom cannot perform a full page load.
 */

const listFn = vi.fn();
const setStatusFn = vi.fn();
const startFn = vi.fn();
const hardNavigate = vi.fn();
const toastError = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		superAdmin: {
			listWaterPurveyors: {
				queryOptions: () => ({
					queryKey: ["superAdmin", "listWaterPurveyors"],
					queryFn: () => listFn(),
				}),
				queryKey: () => ["superAdmin", "listWaterPurveyors"],
			},
			setWaterPurveyorStatus: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["superAdmin", "setWaterPurveyorStatus"],
					mutationFn: (input: unknown) => setStatusFn(input),
				}),
			},
			startImpersonation: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["superAdmin", "startImpersonation"],
					mutationFn: (input: unknown) => startFn(input),
				}),
			},
		},
	},
}));

vi.mock("@/lib/hard-navigate", () => ({
	hardNavigate: (route: string) => hardNavigate(route),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: toastError },
}));

const { WaterPurveyorsTable } = await import("./water-purveyors-table");

const riverside = {
	id: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
	companyName: "Riverside Water District",
	pwsid: "HI-0001",
	status: "active" as const,
	createdAt: new Date("2026-08-01"),
	assets: 12,
	certifiers: 3,
	submissions: 7,
	contact: "Riley Purveyor",
};

const lakeside = {
	...riverside,
	id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
	companyName: "Lakeside Utilities",
	contact: null,
};

const blockedWp = {
	...riverside,
	id: "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901",
	companyName: "Closed Water Co",
	status: "blocked" as const,
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
			<WaterPurveyorsTable />
		</QueryClientProvider>,
	);
}

function rowFor(companyName: string) {
	const cell = screen.getByText(companyName);
	return cell.closest("tr") as HTMLTableRowElement;
}

function impersonateButtonIn(companyName: string) {
	return within(rowFor(companyName)).getByRole("button", {
		name: /impersonate|starting/i,
	}) as HTMLButtonElement;
}

beforeEach(() => {
	listFn.mockReset();
	setStatusFn.mockReset();
	startFn.mockReset();
	hardNavigate.mockReset();
	toastError.mockReset();
	listFn.mockResolvedValue([riverside, lakeside, blockedWp]);
});

afterEach(() => {
	cleanup();
});

describe("WaterPurveyorsTable impersonation", () => {
	it("sends only the row's purveyor id and reloads into /wp on success", async () => {
		startFn.mockResolvedValue({
			waterPurveyorId: riverside.id,
			waterPurveyorName: riverside.companyName,
			expiresAt: new Date(),
		});

		renderTable();
		await screen.findByText(riverside.companyName);

		fireEvent.click(impersonateButtonIn(riverside.companyName));

		await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/wp"));
		// No name, role, tenant or profile from the client — the server decides.
		expect(startFn).toHaveBeenCalledTimes(1);
		expect(startFn).toHaveBeenCalledWith({ waterPurveyorId: riverside.id });
	});

	it("shows the pending row and holds every Impersonate button while starting", async () => {
		let release: ((value: unknown) => void) | undefined;
		startFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		renderTable();
		await screen.findByText(riverside.companyName);

		fireEvent.click(impersonateButtonIn(riverside.companyName));

		await waitFor(() =>
			expect(impersonateButtonIn(riverside.companyName).textContent).toBe(
				"Starting…",
			),
		);
		expect(impersonateButtonIn(riverside.companyName).disabled).toBe(true);
		expect(
			impersonateButtonIn(riverside.companyName).getAttribute("aria-busy"),
		).toBe("true");
		// Other rows wait too — one impersonation at a time — but keep their label.
		expect(impersonateButtonIn(lakeside.companyName).textContent).toBe(
			"Impersonate",
		);
		expect(impersonateButtonIn(lakeside.companyName).disabled).toBe(true);

		fireEvent.click(impersonateButtonIn(lakeside.companyName));
		expect(startFn).toHaveBeenCalledTimes(1);

		await act(async () => {
			release?.({
				waterPurveyorId: riverside.id,
				waterPurveyorName: riverside.companyName,
				expiresAt: new Date(),
			});
		});

		// Still held after success: the page is about to be replaced.
		expect(impersonateButtonIn(riverside.companyName).disabled).toBe(true);
	});

	it("shows the server's refusal and lets the Super-Admin try again", async () => {
		startFn.mockRejectedValue(
			new Error(
				"This water purveyor has no active admin account to impersonate",
			),
		);

		renderTable();
		await screen.findByText(lakeside.companyName);

		fireEvent.click(impersonateButtonIn(lakeside.companyName));

		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				"This water purveyor has no active admin account to impersonate",
			),
		);
		expect(hardNavigate).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(impersonateButtonIn(lakeside.companyName).disabled).toBe(false),
		);
		expect(impersonateButtonIn(riverside.companyName).disabled).toBe(false);
	});

	it("does not offer impersonation of a blocked purveyor", async () => {
		renderTable();
		await screen.findByText(blockedWp.companyName);

		expect(impersonateButtonIn(blockedWp.companyName).disabled).toBe(true);
	});
});
