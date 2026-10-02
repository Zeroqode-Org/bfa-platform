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
			// The PDF button in the document header; nothing here presses it.
			getResultDocumentUrl: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["submittedTests", "getResultDocumentUrl"],
					mutationFn: () =>
						Promise.resolve({ url: "https://example.test/x.pdf" }),
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
		customerName: "Kalani Farms",
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
	it("keeps the table's hidden column label inside its own horizontal scroll", async () => {
		// Regression: the "Actions" header is an `sr-only` span, which is
		// absolutely positioned. With no positioned ancestor its containing block
		// was the viewport, so on a phone it escaped the table's `overflow-x-auto`
		// and the card's `overflow-hidden`, sat at the far edge of the wide table,
		// and made the whole Submitted Tests page scroll sideways. The page-enter
		// animation's transform hid it for 160ms, which is why it looked flaky.
		//
		// jsdom lays nothing out, so this asserts the containing block is where
		// the scrolling happens rather than measuring the page.
		renderTable();
		await screen.findByText("BIN-10041");

		const label = screen.getByText("Actions");
		const container = label.closest('[data-slot="table-container"]');

		expect(label.className).toContain("sr-only");
		expect(container).not.toBeNull();
		expect(container?.className).toContain("overflow-x-auto");
		expect(container?.className).toContain("relative");
	});

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
			target: { value: "03/01/2027" },
		});
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "03/31/2027" },
		});

		// Typed as MM/DD/YYYY, sent as the ISO days the procedure takes.
		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(
				expect.objectContaining({ from: "2027-03-01", to: "2027-03-31" }),
			),
		);
	});

	it("holds the list back while a box holds something that is not a date", async () => {
		renderTable();
		await screen.findByText("BIN-10041");
		const callsBefore = listFn.mock.calls.length;

		const from = screen.getByLabelText("Tested from");
		fireEvent.change(from, { target: { value: "02/30/2027" } });
		fireEvent.blur(from);

		const message = await screen.findByText(
			"Please enter a valid date in MM/DD/YYYY format.",
		);
		expect(from.getAttribute("aria-invalid")).toBe("true");
		expect(from.getAttribute("aria-describedby")).toBe(message.id);
		// Not quietly widened to "no start date" either.
		expect(listFn.mock.calls.length).toBe(callsBefore);
	});

	it("names a backwards range rather than sending it and reporting no results", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "03/31/2027" },
		});
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "03/01/2027" },
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
	it("pins the document's title and close button while the record scrolls", async () => {
		// The record is longer than a screen. It is bounded to the viewport so it
		// cannot run off the bottom, and only the body inside it moves — a popup
		// that scrolled as a whole would carry the title and the close button away
		// with it, which on a short viewport leaves nothing to shut it with but
		// the Escape key.
		//
		// jsdom lays nothing out, so this asserts the contract rather than the
		// pixels.
		await openDocument();

		const dialog = await screen.findByRole("dialog");

		expect(dialog.className).toContain("max-h-[calc(100svh-2rem)]");
		expect(dialog.className).toContain("overflow-hidden");

		const body = dialog.querySelector('[data-slot="dialog-body"]');
		const header = dialog.querySelector('[data-slot="dialog-header"]');
		const close = screen.getByRole("button", { name: "Close" });

		expect(body?.className).toContain("min-h-0");
		expect(body?.className).toContain("overflow-y-auto");
		expect(header?.className).toContain("shrink-0");

		// Both sit in the popup but outside the region that moves.
		expect(body?.contains(header)).toBe(false);
		expect(body?.contains(close)).toBe(false);
		expect(dialog.contains(close)).toBe(true);
	});

	it("keeps Reset and Save corrections outside the scrolling record", async () => {
		// Regression: the corrections bar used to render at the end of the record,
		// inside `DialogBody`, so on any record taller than the screen Save
		// scrolled away with the fields and was clipped at the bottom of the popup.
		await openDocument();

		const dialog = await screen.findByRole("dialog");
		const body = dialog.querySelector('[data-slot="dialog-body"]');
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');
		const save = within(dialog).getByRole("button", {
			name: /Save corrections/,
		});
		const reset = within(dialog).getByRole("button", { name: "Reset" });

		expect(body).not.toBeNull();
		expect(footer).not.toBeNull();
		expect(footer?.className).toContain("shrink-0");

		expect(body?.contains(save)).toBe(false);
		expect(body?.contains(reset)).toBe(false);
		expect(footer?.contains(save)).toBe(true);
		expect(footer?.contains(reset)).toBe(true);

		// And the footer is not a second body: exactly one region scrolls.
		expect(dialog.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(
			1,
		);
	});

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

describe("SubmittedTestsTable — the CSV statement", () => {
	const fetchFn = vi.fn();
	/** The file names the screen asked the browser to save, in order. */
	let saved: string[] = [];

	beforeEach(() => {
		saved = [];
		// jsdom cannot save a file; record what would have been saved instead.
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			saved.push(this.download);
		});
		fetchFn.mockReset();
		fetchFn.mockResolvedValue(
			new Response("csv", {
				status: 200,
				headers: {
					"content-disposition":
						'attachment; filename="submitted-tests_2027-03-01_2027-03-31.csv"',
				},
			}),
		);
		vi.stubGlobal("fetch", fetchFn);
		URL.createObjectURL = vi.fn(() => "blob:statement");
		URL.revokeObjectURL = vi.fn();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function downloadButton() {
		return screen.getByRole("button", { name: /^Download CSV/ });
	}

	it("downloads what the filters select, not only this page", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		await choose("Filter by result", "Fail");
		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "03/01/2027" },
		});
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "03/31/2027" },
		});
		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(
				expect.objectContaining({ from: "2027-03-01", to: "2027-03-31" }),
			),
		);
		await waitFor(() =>
			expect(downloadButton().hasAttribute("disabled")).toBe(false),
		);

		fireEvent.click(downloadButton());

		await waitFor(() =>
			expect(fetchFn).toHaveBeenCalledWith(
				"/api/wp/submitted-tests/export?result=fail&from=2027-03-01&to=2027-03-31",
			),
		);
		// Saved under the name the server gave it, which says the period.
		await waitFor(() =>
			expect(saved).toEqual(["submitted-tests_2027-03-01_2027-03-31.csv"]),
		);
	});

	it("sends no filter at all when none is set", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.click(downloadButton());

		await waitFor(() =>
			expect(fetchFn).toHaveBeenCalledWith("/api/wp/submitted-tests/export"),
		);
	});

	it("offers nothing to download while a box holds something that is not a date", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.change(screen.getByLabelText("Tested from"), {
			target: { value: "02/30/2027" },
		});

		expect(downloadButton().hasAttribute("disabled")).toBe(true);
	});

	it("offers nothing to download when no test matched", async () => {
		listFn.mockResolvedValue(page([]));
		renderTable();
		await screen.findByText("No submitted tests yet");

		expect(downloadButton().hasAttribute("disabled")).toBe(true);
	});

	it("says why the server refused, under the button", async () => {
		fetchFn.mockResolvedValue(
			new Response("More than 5,000 tests match — narrow the date range", {
				status: 413,
			}),
		);
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.click(downloadButton());

		expect((await screen.findByRole("alert")).textContent).toBe(
			"More than 5,000 tests match — narrow the date range",
		);
		expect(saved).toEqual([]);
	});
});

describe("SubmittedTestsTable — quick periods and the customer column", () => {
	beforeEach(() => {
		// 2026-10-02 in Honolulu.
		vi.useFakeTimers({
			toFake: ["Date"],
			now: new Date("2026-10-02T20:00:00Z"),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fills the date boxes from a quick period and asks for that range", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.click(screen.getByRole("button", { name: "Last month" }));

		expect(
			(screen.getByLabelText("Tested from") as HTMLInputElement).value,
		).toBe("09/01/2026");
		expect((screen.getByLabelText("Tested to") as HTMLInputElement).value).toBe(
			"09/30/2026",
		);
		await waitFor(() =>
			expect(listFn).toHaveBeenCalledWith(
				expect.objectContaining({ from: "2026-09-01", to: "2026-09-30" }),
			),
		);
		expect(
			screen
				.getByRole("button", { name: "Last month" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("stops marking a period once the dates are edited away from it", async () => {
		renderTable();
		await screen.findByText("BIN-10041");

		fireEvent.click(screen.getByRole("button", { name: "This month" }));
		fireEvent.change(screen.getByLabelText("Tested to"), {
			target: { value: "10/01/2026" },
		});

		expect(
			screen
				.getByRole("button", { name: "This month" })
				.getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("counts the whole set on the download button, not the page on screen", async () => {
		listFn.mockResolvedValue(page([submission()], { total: 30, pageCount: 2 }));
		renderTable();
		await screen.findByText("BIN-10041");

		expect(
			await screen.findByRole("button", { name: "Download CSV (30)" }),
		).toBeTruthy();
	});

	it("names the customer on each row", async () => {
		renderTable();

		expect(await screen.findByText("Kalani Farms")).toBeTruthy();
	});
});
