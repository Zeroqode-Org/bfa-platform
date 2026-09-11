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

import type { Submission, SubmissionDetail } from "./submission-types";

/**
 * The submitted-tests screen: what the list says about a row, what the document
 * view shows when one is opened, and which controls exist for which role.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the components still run against
 * genuine React Query state — only the transport is replaced.
 *
 * The three things worth testing here that a router test cannot reach: that a
 * field named in `overridden_fields` is flagged where a reader will see it,
 * that an unresolved submission offers the link flow, and that a WP Employee is
 * shown a record rather than controls that would be refused.
 */

const listFn = vi.fn();
const getFn = vi.fn();
const updateFn = vi.fn();
const linkFn = vi.fn();
const whoamiFn = vi.fn();
const listAssetsFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		whoami: {
			queryOptions: () => ({
				queryKey: ["whoami"],
				queryFn: () => whoamiFn(),
			}),
		},
		assets: {
			listAssets: {
				queryOptions: (input: unknown) => ({
					queryKey: ["assets", "listAssets", input],
					queryFn: () => listAssetsFn(input),
				}),
				queryKey: () => ["assets", "listAssets"],
			},
		},
		submittedTests: {
			listSubmittedTests: {
				queryOptions: (input: unknown, options: Record<string, unknown>) => ({
					...options,
					queryKey: ["submittedTests", "listSubmittedTests", input],
					queryFn: () => listFn(input),
				}),
				queryKey: () => ["submittedTests", "listSubmittedTests"],
			},
			getSubmittedTest: {
				queryOptions: (input: { id: string }) => ({
					queryKey: ["submittedTests", "getSubmittedTest", input],
					queryFn: () => getFn(input),
				}),
				queryKey: (input: { id: string }) => [
					"submittedTests",
					"getSubmittedTest",
					input,
				],
			},
			updateSubmittedTest: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["submittedTests", "updateSubmittedTest"],
					mutationFn: (input: unknown) => updateFn(input),
				}),
			},
			linkSubmissionAsset: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["submittedTests", "linkSubmissionAsset"],
					mutationFn: (input: unknown) => linkFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { SubmittedTestsTable } = await import("./submitted-tests-table");

const SUBMISSION_ID = "6b3e1c22-8f4a-4d61-9c07-2a1b3c4d5e6f";
const ASSET_ID = "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607";

function submission(overrides: Partial<Submission> = {}): Submission {
	return {
		id: SUBMISSION_ID,
		bfaAssetId: ASSET_ID,
		certifierId: "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901",
		status: "submitted",
		bfaType: "RP",
		wizardData: { linePressure: 62 },
		submittedBinText: null,
		testDate: "2027-04-01",
		testResult: "pass",
		overriddenFields: null,
		signatureMethod: "signed",
		signatureData: null,
		editedByWpProfileId: null,
		createdAt: "2027-04-01T00:00:00.000Z",
		updatedAt: "2027-04-01T00:00:00.000Z",
		bin: "BIN-10041",
		serviceAddress: "18 Canal Road",
		certifierName: "Casey Certifier",
		...overrides,
	} as Submission;
}

function detail(overrides: Partial<SubmissionDetail> = {}): SubmissionDetail {
	return { ...submission(), ...overrides } as SubmissionDetail;
}

function page(rows: Submission[], overrides: Record<string, number> = {}) {
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
			<SubmittedTestsTable />
		</QueryClientProvider>,
	);
}

/**
 * Opens the first row's document and waits for the record to arrive.
 *
 * The dialog frame renders before the detail query resolves, so waiting on the
 * dialog alone would hand back a skeleton.
 */
async function openDocument() {
	renderTable();
	fireEvent.click(await screen.findByRole("button", { name: "Open" }));

	const dialog = within(await screen.findByRole("dialog"));
	await dialog.findByText("Test record");

	return dialog;
}

/** Base UI commits an option on the pointer sequence, not on a bare click. */
async function choose(triggerLabel: string, optionName: string) {
	fireEvent.click(screen.getByLabelText(triggerLabel));

	const option = await screen.findByRole("option", { name: optionName });
	fireEvent.pointerDown(option);
	fireEvent.pointerUp(option);
	fireEvent.click(option);
}

beforeEach(() => {
	listFn.mockReset();
	getFn.mockReset();
	updateFn.mockReset();
	linkFn.mockReset();
	whoamiFn.mockReset();
	listAssetsFn.mockReset();

	listFn.mockResolvedValue(page([submission()]));
	getFn.mockResolvedValue(detail());
	updateFn.mockImplementation(async (input) => ({ ...detail(), ...input }));
	linkFn.mockResolvedValue(detail());
	whoamiFn.mockResolvedValue({
		profileId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		globalRole: "wp_admin",
		waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
	});
	listAssetsFn.mockResolvedValue({
		rows: [
			{
				id: ASSET_ID,
				bin: "BIN-10041",
				bfaType: "RP",
				serviceAddress: "18 Canal Road",
			},
		],
		total: 1,
		page: 1,
		pageSize: 6,
		pageCount: 1,
	});
});

afterEach(() => {
	cleanup();
});

describe("SubmittedTestsTable — the list", () => {
	it("shows the five facts every submitted row carries", async () => {
		renderTable();

		expect(await screen.findByText("BIN-10041")).toBeTruthy();
		expect(screen.getByText("RP")).toBeTruthy();
		expect(screen.getByText("Apr 1, 2027")).toBeTruthy();
		expect(screen.getByText("Pass")).toBeTruthy();
		expect(screen.getByText("Casey Certifier")).toBeTruthy();
	});

	it("colours a failure differently from a pass", async () => {
		listFn.mockResolvedValue(
			page([
				submission({ id: "a", bin: "BIN-1", testResult: "pass" }),
				submission({ id: "b", bin: "BIN-2", testResult: "fail" }),
			]),
		);

		renderTable();

		expect(await screen.findByText("Pass")).toBeTruthy();
		expect(screen.getByText("Fail")).toBeTruthy();
	});

	it("shows what the certifier typed when the row resolved to no asset", async () => {
		// The row this screen exists to surface: the reader scanning the list is
		// looking for exactly these, so the state is on the row rather than only
		// inside it.
		listFn.mockResolvedValue(
			page([
				submission({
					bfaAssetId: null,
					bin: null,
					submittedBinText: "HRB-?? 0142",
				}),
			]),
		);

		renderTable();

		expect(await screen.findByText("HRB-?? 0142")).toBeTruthy();
		expect(
			screen.getAllByText("Not linked to an asset").length,
		).toBeGreaterThan(0);
	});

	it("says so rather than going blank when the certifier left the BIN out entirely", async () => {
		listFn.mockResolvedValue(
			page([
				submission({ bfaAssetId: null, bin: null, submittedBinText: null }),
			]),
		);

		renderTable();

		expect(await screen.findByText("No BIN given")).toBeTruthy();
	});

	it("filters by result", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		await choose("Filter by result", "Fail");

		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(
				expect.objectContaining({ result: "fail" }),
			),
		);
	});

	it("sends both ends of the date range, which the server includes", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "2027-03-01" },
		});
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "2027-03-31" },
		});

		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(
				expect.objectContaining({ from: "2027-03-01", to: "2027-03-31" }),
			),
		);
	});

	it("names a backwards range rather than sending it and reporting no results", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "2027-03-31" },
		});
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "2027-03-01" },
		});

		expect(
			await screen.findByText("That date range runs backwards"),
		).toBeTruthy();
		// Not a request that comes back empty — a typo the reader can see. The
		// half-typed range on the way here is a real question and does get asked;
		// the impossible one never does.
		expect(listFn).not.toHaveBeenCalledWith(
			expect.objectContaining({ from: "2027-03-31", to: "2027-03-01" }),
		);
	});

	it("tells a purveyor with nothing filed that drafts never appear here", async () => {
		listFn.mockResolvedValue(page([]));

		renderTable();

		expect(await screen.findByText("No submitted tests yet")).toBeTruthy();
		expect(screen.getByText(/Drafts never do/)).toBeTruthy();
	});

	it("says the filters emptied the table when a narrowed list finds nothing", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		listFn.mockResolvedValue(page([]));
		await choose("Filter by result", "Fail");

		// A different nothing from the one above: the fix is to widen the filter,
		// not to wait for a certifier.
		expect(
			await screen.findByText("No tests match these filters"),
		).toBeTruthy();
	});

	it("shows the server's message and a retry when the list fails", async () => {
		listFn.mockRejectedValue(new Error("Water Purveyor only"));

		renderTable();

		expect(
			await screen.findByText("Couldn’t load submitted tests"),
		).toBeTruthy();
		expect(screen.getByText("Water Purveyor only")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});

	it("pages only when there is a second page to reach", async () => {
		listFn.mockResolvedValue(page([submission()], { total: 60, pageCount: 3 }));

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
});

describe("SubmittedTestsTable — the document view", () => {
	it("opens the stored record rather than the list row", async () => {
		const dialog = await openDocument();

		expect(getFn).toHaveBeenCalledWith({ id: SUBMISSION_ID });
		expect(dialog.getByText(/Casey Certifier/)).toBeTruthy();
	});

	it("flags a field the certifier typed over a prefilled value", async () => {
		// PRD § 9: overwritten values are "visibly flagged to the WP, not silently
		// replaced" — the final value alone does not say whether somebody typed
		// over a known-good reading.
		getFn.mockResolvedValue(
			detail({
				wizardData: { linePressure: 62 },
				overriddenFields: ["linePressure"],
			}),
		);

		const dialog = await openDocument();

		expect(dialog.getByText("Overwritten by the certifier")).toBeTruthy();
	});

	it("flags an overridden field named by an object marker too", async () => {
		// A `{ field: previousValue }` map is the other spelling the column can
		// carry; the wizard that writes it is week 4.
		getFn.mockResolvedValue(
			detail({ testResult: "pass", overriddenFields: { testResult: "fail" } }),
		);

		const dialog = await openDocument();

		expect(dialog.getByText("Overwritten by the certifier")).toBeTruthy();
	});

	it("flags nothing when the certifier overwrote nothing", async () => {
		const dialog = await openDocument();

		expect(dialog.queryByText("Overwritten by the certifier")).toBeNull();
	});

	it("saves a corrected field as the whole record", async () => {
		const dialog = await openDocument();

		fireEvent.change(dialog.getByLabelText("Line Pressure"), {
			target: { value: "64" },
		});
		fireEvent.click(dialog.getByRole("button", { name: /Save corrections/ }));

		await waitFor(() => expect(updateFn).toHaveBeenCalled());

		expect(updateFn).toHaveBeenCalledWith(
			expect.objectContaining({
				id: SUBMISSION_ID,
				// The field that held a number still holds one — a reading corrected
				// from 62 to 64 must not quietly become the string "64".
				wizardData: { linePressure: 64 },
				// Every field is sent, so an omitted one is a field being cleared.
				bfaType: "RP",
				testDate: "2027-04-01",
				testResult: "pass",
			}),
		);
	});

	it("never sends a tenant, an actor or a status with a correction", async () => {
		const dialog = await openDocument();

		fireEvent.change(dialog.getByLabelText("Line Pressure"), {
			target: { value: "64" },
		});
		fireEvent.click(dialog.getByRole("button", { name: /Save corrections/ }));

		await waitFor(() => expect(updateFn).toHaveBeenCalled());

		const payload = updateFn.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload).not.toHaveProperty("waterPurveyorId");
		expect(payload).not.toHaveProperty("editedByWpProfileId");
		expect(payload).not.toHaveProperty("status");
		expect(payload).not.toHaveProperty("overriddenFields");
	});

	it("puts a typed value back the way it was stored when Reset is pressed", async () => {
		const dialog = await openDocument();
		const field = dialog.getByLabelText("Line Pressure") as HTMLInputElement;

		fireEvent.change(field, { target: { value: "64" } });
		fireEvent.click(dialog.getByRole("button", { name: "Reset" }));

		expect(
			(dialog.getByLabelText("Line Pressure") as HTMLInputElement).value,
		).toBe("62");
	});
});

describe("SubmittedTestsTable — linking an unresolved submission", () => {
	const unresolved = detail({
		bfaAssetId: null,
		bin: null,
		serviceAddress: null,
		submittedBinText: "HRB-?? 0142",
	});

	beforeEach(() => {
		listFn.mockResolvedValue(
			page([
				submission({
					bfaAssetId: null,
					bin: null,
					submittedBinText: "HRB-?? 0142",
				}),
			]),
		);
		getFn.mockResolvedValue(unresolved);
	});

	it("offers the link flow, seeded with what the certifier typed", async () => {
		const dialog = await openDocument();

		expect(
			dialog.getByText("This test is not linked to an asset"),
		).toBeTruthy();
		expect(
			(
				dialog.getByLabelText(
					"Search your assets by BIN or service address",
				) as HTMLInputElement
			).value,
		).toBe("HRB-?? 0142");
	});

	it("searches the caller's own assets, which is the only list it can offer", async () => {
		await openDocument();

		await waitFor(() =>
			expect(listAssetsFn).toHaveBeenCalledWith(
				expect.objectContaining({ search: "HRB-?? 0142" }),
			),
		);
	});

	it("attaches the chosen asset by id", async () => {
		const dialog = await openDocument();

		fireEvent.click(await dialog.findByRole("button", { name: "Link" }));

		await waitFor(() =>
			expect(linkFn).toHaveBeenCalledWith({
				submissionId: SUBMISSION_ID,
				assetId: ASSET_ID,
			}),
		);
	});

	it("refetches the list and the record after linking", async () => {
		const dialog = await openDocument();

		fireEvent.click(await dialog.findByRole("button", { name: "Link" }));

		// Linking changes which BIN the row shows, so the position it holds in a
		// list the server sorts is the server's to decide again.
		await waitFor(() => expect(listFn.mock.calls.length).toBeGreaterThan(1));
		await waitFor(() => expect(getFn.mock.calls.length).toBeGreaterThan(1));
	});

	it("does not offer the link panel on a submission that already resolved", async () => {
		getFn.mockResolvedValue(detail());
		listFn.mockResolvedValue(page([submission()]));

		const dialog = await openDocument();

		expect(
			dialog.queryByText("This test is not linked to an asset"),
		).toBeNull();
	});
});

describe("SubmittedTestsTable — a WP Employee", () => {
	beforeEach(() => {
		whoamiFn.mockResolvedValue({
			profileId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
			globalRole: "wp_employee",
			waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
		});
	});

	it("reads the list like anybody else", async () => {
		renderTable();

		expect(await screen.findByText("BIN-10041")).toBeTruthy();
	});

	it("reads the document without controls that would be refused", async () => {
		const dialog = await openDocument();

		await waitFor(() =>
			expect(dialog.getByText(/read submitted tests/)).toBeTruthy(),
		);
		expect(
			dialog.queryByRole("button", { name: /Save corrections/ }),
		).toBeNull();
		expect(dialog.queryByLabelText("Line Pressure")).toBeNull();
		// The value is still readable — it is the input that is absent, not the
		// record.
		expect(dialog.getByText("62")).toBeTruthy();
	});

	it("still sees a field the certifier overwrote", async () => {
		// The flag is on the label rather than inside the control, so it survives
		// the read-only rendering — the people who cannot change a value are
		// exactly the ones who most need to know it was changed.
		getFn.mockResolvedValue(
			detail({
				wizardData: { linePressure: 62 },
				overriddenFields: ["linePressure"],
			}),
		);

		const dialog = await openDocument();

		await waitFor(() =>
			expect(dialog.getByText("Overwritten by the certifier")).toBeTruthy(),
		);
	});

	it("is told why the link flow is not offered on an unresolved test", async () => {
		getFn.mockResolvedValue(
			detail({ bfaAssetId: null, bin: null, submittedBinText: "HRB-?? 0142" }),
		);

		const dialog = await openDocument();

		await waitFor(() =>
			expect(
				dialog.getByText("This test is not linked to an asset"),
			).toBeTruthy(),
		);
		expect(
			dialog.queryByLabelText("Search your assets by BIN or service address"),
		).toBeNull();
	});
});
