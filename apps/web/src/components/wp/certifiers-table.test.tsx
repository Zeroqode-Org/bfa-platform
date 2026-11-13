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

import type { WpCertifier } from "./certifier-types";

/**
 * The certifiers table's block and unblock controls — the two actions that
 * decide whether a certifier can work for this water purveyor.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the component still runs against
 * genuine React Query state — only the transport is replaced.
 */

const listFn = vi.fn();
const setStatusFn = vi.fn();
const setTypeFn = vi.fn();
const inviteFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		certifiers: {
			listWpCertifiers: {
				queryOptions: () => ({
					queryKey: ["certifiers", "listWpCertifiers"],
					queryFn: () => listFn(),
				}),
				queryKey: () => ["certifiers", "listWpCertifiers"],
			},
			setCertifierStatus: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["certifiers", "setCertifierStatus"],
					mutationFn: (input: unknown) => setStatusFn(input),
				}),
			},
			setCertifierType: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["certifiers", "setCertifierType"],
					mutationFn: (input: unknown) => setTypeFn(input),
				}),
			},
		},
		invitations: {
			createInvitation: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["invitations", "createInvitation"],
					mutationFn: (input: unknown) => inviteFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { CertifiersTable } = await import("./certifiers-table");

const active: WpCertifier = {
	id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
	fullName: "Ada Tester",
	company: "Island Backflow Testing",
	idNumber: "LIC-4471",
	licenseExpirationDate: "2027-04-30",
	status: "active",
	certifierType: "internal",
};

const blocked: WpCertifier = {
	id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
	fullName: "Zoe Shared",
	company: null,
	idNumber: null,
	licenseExpirationDate: null,
	status: "blocked",
	certifierType: "internal",
};

const outside: WpCertifier = {
	id: "c0ffee00-1234-4567-89ab-cdef01234567",
	fullName: "Kai External",
	company: "Kai Testing LLC",
	idNumber: "LIC-9001",
	licenseExpirationDate: "2028-01-15",
	status: "active",
	certifierType: "external",
};

function renderTable({ canManage = true }: { canManage?: boolean } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	render(
		<QueryClientProvider client={queryClient}>
			<CertifiersTable canManage={canManage} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listFn.mockReset();
	setStatusFn.mockReset();
	setTypeFn.mockReset();
	inviteFn.mockReset();
	listFn.mockResolvedValue([active, blocked]);
	setStatusFn.mockImplementation(
		(input: { id: string; status: WpCertifier["status"] }) =>
			Promise.resolve({
				...(input.id === active.id ? active : blocked),
				status: input.status,
			}),
	);
});

afterEach(() => {
	cleanup();
});

describe("CertifiersTable", () => {
	it("renders every column the screen promises", async () => {
		renderTable();

		await screen.findByText("Ada Tester");
		for (const header of [
			"Name",
			"Company",
			"ID number",
			"License expiration",
			"Status",
		]) {
			expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
		}
		expect(screen.getByText("Island Backflow Testing")).toBeTruthy();
		expect(screen.getByText("LIC-4471")).toBeTruthy();
		expect(screen.getByText("Apr 30, 2027")).toBeTruthy();
	});

	it("lists blocked certifiers alongside active ones, so they can be unblocked", async () => {
		renderTable();

		expect(await screen.findByText("Ada Tester")).toBeTruthy();
		expect(screen.getByText("Zoe Shared")).toBeTruthy();
		expect(screen.getByText("Blocked")).toBeTruthy();
		expect(screen.getByText("Active")).toBeTruthy();
	});

	it("spells out what a blocked status means", async () => {
		renderTable();

		await screen.findByText("Blocked");
		// "Blocked" on its own leaves the consequence to be guessed at.
		expect(screen.getByText("Cannot submit tests to you")).toBeTruthy();
	});

	it("shows a dash rather than a blank cell for a missing detail", async () => {
		renderTable();

		await screen.findByText("Zoe Shared");
		// Company, ID number and licence expiry, all absent on the blocked row.
		expect(screen.getAllByText("—")).toHaveLength(3);
	});

	it("names the row in each action's accessible label", async () => {
		renderTable();

		expect(
			await screen.findByRole("button", { name: "Block Ada Tester" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Unblock Zoe Shared" }),
		).toBeTruthy();
	});

	it("offers no way to delete a certifier or edit their record", async () => {
		renderTable();

		await screen.findByText("Ada Tester");
		expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /^edit/i })).toBeNull();
	});

	it("asks before blocking, and says that access to this purveyor goes", async () => {
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: "Block Ada Tester" }),
		);

		expect(
			await screen.findByText(/access to your water purveyor/i),
		).toBeTruthy();
		// Nothing has been sent yet — the dialog is a question, not a progress bar.
		expect(setStatusFn).not.toHaveBeenCalled();
	});

	it("spells out that blocking leaves the certifier's other purveyors alone", async () => {
		// The block revokes this purveyor's authorization only. A clerk who
		// expects "block" to ban the person outright should be told it does not.
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: "Block Ada Tester" }),
		);

		expect(await screen.findByText(/that work is unaffected/i)).toBeTruthy();
	});

	it("does not reveal whether this certifier works for anyone else", async () => {
		// The dialog has to state the rule without disclosing the fact. How many
		// other purveyors authorized this person is in `wp_certifier_authorizations`
		// and is those purveyors' business — "also works for 2 other water
		// purveyors" would leak their existence across the boundary the rest of
		// this screen is built to hold.
		//
		// So the copy is conditional, and the assertion is on the two shapes a
		// disclosure would take: a count, or a claim in the present indicative.
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: "Block Ada Tester" }),
		);

		const dialogCopy = (
			await screen.findByText(/access to your water purveyor/i)
		).parentElement?.textContent;

		expect(dialogCopy).toMatch(/if they also work for other water purveyors/i);
		expect(dialogCopy).not.toMatch(/\d+\s+other/i);
		expect(dialogCopy).not.toMatch(/(currently|already) works for/i);
		expect(dialogCopy).not.toMatch(/is authorized by/i);
	});

	it("sends only the id and the new status once blocking is confirmed", async () => {
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: "Block Ada Tester" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Block certifier" }),
		);

		await waitFor(() => expect(setStatusFn).toHaveBeenCalledTimes(1));
		expect(setStatusFn).toHaveBeenCalledWith({
			id: active.id,
			status: "blocked",
		});
	});

	it("unblocks without a confirmation — giving access back is not the destructive direction", async () => {
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: "Unblock Zoe Shared" }),
		);

		await waitFor(() => expect(setStatusFn).toHaveBeenCalledTimes(1));
		expect(setStatusFn).toHaveBeenCalledWith({
			id: blocked.id,
			status: "active",
		});
	});

	it("reports pending on the row being changed and on no other", async () => {
		// One mutation drives every row's button. Without scoping the pending
		// state to `variables.id`, blocking one certifier would relabel the button
		// on all of them.
		let release: ((value: unknown) => void) | undefined;
		setStatusFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		renderTable();

		fireEvent.click(
			await screen.findByRole("button", { name: "Unblock Zoe Shared" }),
		);

		await waitFor(() => expect(screen.getByText("Unblocking…")).toBeTruthy());
		expect(screen.getByText("Block")).toBeTruthy();
		expect(screen.queryByText("Blocking…")).toBeNull();

		await act(async () => {
			release?.({ ...blocked, status: "active" });
		});
	});

	it("flags a licence that has already expired", async () => {
		listFn.mockResolvedValue([
			{ ...active, licenseExpirationDate: "2020-01-15" },
		]);
		renderTable();

		expect(await screen.findByText("License expired")).toBeTruthy();
	});

	it("shows a skeleton row set while the list is loading", async () => {
		let release: ((value: unknown) => void) | undefined;
		listFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		renderTable();

		// No data yet, and no empty state pretending there is none.
		expect(screen.queryByText("No certifiers yet")).toBeNull();
		expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
		expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(24);

		await act(async () => {
			release?.([active]);
		});
	});

	it("offers a way to invite the first certifier when there are none", async () => {
		listFn.mockResolvedValue([]);
		renderTable();

		expect(await screen.findByText("No internal certifiers yet")).toBeTruthy();
	});

	it("shows the server's message and a retry when the list fails to load", async () => {
		listFn.mockRejectedValue(new Error("Water Purveyor only"));
		renderTable();

		expect(await screen.findByText("Water Purveyor only")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});

	it("retries the list when the error state's button is pressed", async () => {
		listFn.mockRejectedValueOnce(new Error("Water Purveyor only"));
		renderTable();

		fireEvent.click(await screen.findByRole("button", { name: /try again/i }));

		expect(await screen.findByText("Ada Tester")).toBeTruthy();
	});

	it("offers an invite control above the table", async () => {
		renderTable();

		await screen.findByText("Ada Tester");
		expect(
			screen.getByRole("button", { name: /invite certifier/i }),
		).toBeTruthy();
	});

	it("opens on the internal tab and lists only internal certifiers", async () => {
		listFn.mockResolvedValue([active, outside]);
		renderTable();

		expect(await screen.findByText("Ada Tester")).toBeTruthy();
		expect(screen.queryByText("Kai External")).toBeNull();
		expect(
			screen
				.getByRole("tab", { name: /internal certifiers/i })
				.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("switches to the external certifiers when that tab is pressed", async () => {
		listFn.mockResolvedValue([active, outside]);
		renderTable();

		await screen.findByText("Ada Tester");
		fireEvent.click(screen.getByRole("tab", { name: /external certifiers/i }));

		expect(screen.getByText("Kai External")).toBeTruthy();
		expect(screen.queryByText("Ada Tester")).toBeNull();
	});

	it("counts each tab's certifiers on the tab itself", async () => {
		listFn.mockResolvedValue([active, blocked, outside]);
		renderTable();

		await screen.findByText("Ada Tester");
		expect(
			screen.getByRole("tab", { name: /internal certifiers/i }).textContent,
		).toContain("2");
		expect(
			screen.getByRole("tab", { name: /external certifiers/i }).textContent,
		).toContain("1");
	});

	it("points an empty tab at the other one when the purveyor has certifiers there", async () => {
		listFn.mockResolvedValue([active]);
		renderTable();

		await screen.findByText("Ada Tester");
		fireEvent.click(screen.getByRole("tab", { name: /external certifiers/i }));

		expect(screen.getByText("No external certifiers yet")).toBeTruthy();
		expect(
			screen.getByText(/move a certifier here from the internal tab/i),
		).toBeTruthy();
	});

	it("moves a certifier to the other tab, sending only the id and the new type", async () => {
		setTypeFn.mockResolvedValue({
			id: active.id,
			fullName: active.fullName,
			certifierType: "external",
		});
		renderTable();

		fireEvent.click(
			await screen.findByRole("button", {
				name: "Move Ada Tester to external certifiers",
			}),
		);

		await waitFor(() => expect(setTypeFn).toHaveBeenCalledTimes(1));
		expect(setTypeFn.mock.calls[0]?.[0]).toEqual({
			id: active.id,
			certifierType: "external",
		});
	});

	it("opens on the external tab when every certifier is external", async () => {
		// The state every purveyor is in right after the release: all existing
		// authorizations were filed as external.
		listFn.mockResolvedValue([outside]);
		renderTable();

		expect(await screen.findByText("Kai External")).toBeTruthy();
		expect(
			screen
				.getByRole("tab", { name: /external certifiers/i })
				.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("labels the table as the panel of the selected tab", async () => {
		listFn.mockResolvedValue([active, outside]);
		renderTable();

		await screen.findByText("Ada Tester");
		const tab = screen.getByRole("tab", { name: /internal certifiers/i });
		const panel = screen.getByRole("tabpanel");

		expect(tab.getAttribute("aria-controls")).toBe(panel.id);
		expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
	});

	it("moves between the tabs with the arrow keys", async () => {
		listFn.mockResolvedValue([active, outside]);
		renderTable();

		await screen.findByText("Ada Tester");
		fireEvent.keyDown(
			screen.getByRole("tab", { name: /internal certifiers/i }),
			{
				key: "ArrowRight",
			},
		);

		expect(screen.getByText("Kai External")).toBeTruthy();
		const external = screen.getByRole("tab", { name: /external certifiers/i });
		expect(external.getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(external);
	});

	it("shows no row actions to a WP Employee, who would only be refused", async () => {
		renderTable({ canManage: false });

		await screen.findByText("Ada Tester");
		expect(screen.queryByRole("button", { name: /^block/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /^move/i })).toBeNull();
	});
});
