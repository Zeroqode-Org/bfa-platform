// @vitest-environment jsdom

import { ASSET_FIELD_LIMITS } from "@bfa-platform/api/lib/asset-field-limits";
import {
	DATE_MESSAGE,
	maxLengthMessage,
} from "@bfa-platform/ui/lib/validation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AddAssetForm,
	assetToFormValues,
	buildAssetPayload,
	DEFAULT_ASSEMBLY_LOCATION,
	EditAssetForm,
	emptyAssetValues,
} from "./asset-form";
import type { Asset } from "./asset-types";
import { assetFormErrors } from "./asset-types";

/**
 * The asset form: what it sends, what it refuses inline before sending, and
 * what it refuses to carry.
 *
 * The payload builder is exercised directly as well as through the DOM — it is
 * where the client's half of "the scheduler owns the status, and occupancy
 * changes are their own act" lives, and that has to hold whichever control set
 * the values.
 */

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
		assemblyLocation: "Meter pit, north side",
		annualTestDate: "2027-04-01",
		assetStatus: "active",
		currentCustomerId: null,
		currentCustomerName: null,
		currentCustomerStatus: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

/** Opens the BFA type select and commits one type. */
function chooseBfaType(type: string) {
	fireEvent.click(screen.getByLabelText("BFA type"));

	// Base UI commits an option on the pointer sequence, not on a bare click.
	const item = screen.getByRole("option", { name: type });
	fireEvent.pointerDown(item);
	fireEvent.pointerUp(item);
	fireEvent.click(item);
}

function fillRequired({
	bin = "BIN-10041",
	bfaType = "RP" as string | null,
	serviceAddress = "18 Canal Road",
	assemblyLocation = "Meter pit, north side",
	make = "Watts",
	model = "909",
	serialNumber = "SN-88120",
	size = "2 in",
	annualTestDate = "04/01/2027",
} = {}) {
	fireEvent.change(screen.getByLabelText("BIN"), { target: { value: bin } });
	if (bfaType) chooseBfaType(bfaType);
	for (const [label, value] of [
		["Service address", serviceAddress],
		["Assembly location", assemblyLocation],
		["Make", make],
		["Model", model],
		["Serial number", serialNumber],
		["Size", size],
		["Annual test date", annualTestDate],
	] as const) {
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	}
}

afterEach(() => {
	cleanup();
});

describe("buildAssetPayload", () => {
	it("trims every text field it sends", () => {
		expect(
			buildAssetPayload({
				...emptyAssetValues,
				bfaType: "RP",
				bin: "  BIN-10041 ",
				serviceAddress: " 18 Canal Road ",
				make: "  Watts ",
				model: " 909",
				annualTestDate: "04/01/2027",
			}),
		).toMatchObject({
			bin: "BIN-10041",
			serviceAddress: "18 Canal Road",
			make: "Watts",
			model: "909",
			annualTestDate: "2027-04-01",
		});
	});

	it("names neither the tenant, the status nor the current customer", () => {
		// All three are the server's: the tenant from the caller's profile, the
		// status from the scheduler, and the customer from `assignCustomer`, which
		// records the occupancy change rather than moving a pointer.
		const keys = Object.keys(buildAssetPayload(assetToFormValues(asset())));

		expect(keys).not.toContain("waterPurveyorId");
		expect(keys).not.toContain("assetStatus");
		expect(keys).not.toContain("currentCustomerId");
	});
});

describe("assetToFormValues", () => {
	it("turns null columns into empty fields and shows the date as MM/DD/YYYY", () => {
		expect(
			assetToFormValues(
				asset({ make: null, model: null, assemblyLocation: null }),
			),
		).toMatchObject({
			make: "",
			model: "",
			assemblyLocation: "",
			annualTestDate: "04/01/2027",
		});
	});
});

describe("AddAssetForm", () => {
	it("opts out of browser validation and carries no native constraints", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		const form = screen
			.getByRole("button", { name: "Add asset" })
			.closest("form") as HTMLFormElement;

		expect(form.noValidate).toBe(true);
		expect(form.querySelectorAll("[required]")).toHaveLength(0);
		expect(form.querySelectorAll("[maxlength]")).toHaveLength(0);
		expect(form.querySelectorAll('input[type="date"]')).toHaveLength(0);
	});

	it("submits the typed values, with the annual test date the schedule needs", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired();
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).toHaveBeenCalledWith({
			bin: "BIN-10041",
			bfaType: "RP",
			serviceAddress: "18 Canal Road",
			assemblyLocation: "Meter pit, north side",
			make: "Watts",
			model: "909",
			serialNumber: "SN-88120",
			size: "2 in",
			annualTestDate: "2027-04-01",
		});
	});

	it("opens a new asset with RP and the usual assembly location filled in", () => {
		// The commonest answers, already there (WP/Admin feedback).
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		const type = screen.getByLabelText("BFA type");
		expect(type.textContent).toContain("RP");
		expect(type.textContent).not.toContain("Select…");
		expect(
			screen.getByLabelText<HTMLInputElement>("Assembly location").value,
		).toBe(DEFAULT_ASSEMBLY_LOCATION);
		expect(DEFAULT_ASSEMBLY_LOCATION).toBe(
			"After meter prior to any tees or branches",
		);
	});

	it("sends the prefilled answers when they are left alone", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired({
			bfaType: null,
			assemblyLocation: DEFAULT_ASSEMBLY_LOCATION,
		});
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				bfaType: "RP",
				assemblyLocation: DEFAULT_ASSEMBLY_LOCATION,
			}),
		);
	});

	it("lets both prefilled answers be changed", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired({
			bfaType: "DCDA",
			assemblyLocation: "Meter pit, north side",
		});
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				bfaType: "DCDA",
				assemblyLocation: "Meter pit, north side",
			}),
		);
	});

	it("still requires an assembly location once the prefilled one is cleared", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired({ assemblyLocation: "" });
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("An assembly location is required.")).toBeTruthy();
	});

	it("keeps save available and names every missing answer when pressed", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		const save = screen.getByRole("button", { name: "Add asset" });
		// Not a dead button to interpret: pressing it says what is missing.
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(screen.queryAllByRole("alert")).toHaveLength(0);

		fireEvent.click(save);

		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual([
			// The BFA type and the assembly location open filled in, so they are
			// not among the missing.
			"A BIN is required.",
			"A service address is required.",
			"A make is required.",
			"A model is required.",
			"A serial number is required.",
			"A size is required.",
			"An annual test date is required.",
		]);
		expect(document.activeElement).toBe(screen.getByLabelText("BIN"));
	});

	it("keeps the annual test date's hint alongside its error", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		const date = screen.getByLabelText("Annual test date");
		const message = screen.getByText("An annual test date is required.");
		const hint = screen.getByText(/The reminder goes out/);

		expect(date.getAttribute("aria-describedby")).toBe(
			`${message.id} ${hint.id}`,
		);
	});

	it("treats a BIN of only spaces as empty, the way the server does", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired({ bin: "   " });
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("A BIN is required.")).toBeTruthy();
	});

	it("refuses a date that is not a real calendar day", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		// 31 February parses to 3 March if nothing checks — a reminder that would
		// fire on a day nobody chose.
		fillRequired({ annualTestDate: "02/31/2027" });
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();
		expect(document.activeElement).toBe(
			screen.getByLabelText("Annual test date"),
		);
	});

	it("reports the API schema's length limits at the field instead of cutting text off", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		const bin = screen.getByLabelText("BIN") as HTMLInputElement;
		const tooLong = "B".repeat(ASSET_FIELD_LIMITS.bin + 1);
		fillRequired({ bin: tooLong });

		// Nothing silently trimmed: the whole value is still there to shorten.
		expect(bin.value).toBe(tooLong);

		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getByText(maxLengthMessage(ASSET_FIELD_LIMITS.bin)),
		).toBeTruthy();
	});

	it("keeps the serial number free text", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired();
		fireEvent.change(screen.getByLabelText("Serial number"), {
			target: { value: "SN-88120 / rev B" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ serialNumber: "SN-88120 / rev B" }),
		);
	});

	it("offers no control for the status the scheduler computes", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		expect(screen.queryByLabelText("Status")).toBeNull();
	});

	it("marks the assembly's description required, and refuses one left blank", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		for (const label of [
			"Assembly location",
			"Make",
			"Model",
			"Serial number",
			"Size",
		]) {
			expect(screen.getByLabelText(label).getAttribute("aria-required")).toBe(
				"true",
			);
		}

		fillRequired({ make: "   " });
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("A make is required.")).toBeTruthy();
		expect(document.activeElement).toBe(screen.getByLabelText("Make"));
	});

	it("has no customer control — a customer reaches an asset from the customer form", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		expect(screen.queryByLabelText("Customer")).toBeNull();
	});

	it("does not warn about a BIN change on a record that has no old BIN", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-10041" },
		});

		expect(screen.queryByText(/Changing a BIN is recorded/)).toBeNull();
	});
});

describe("AddAssetForm — annual test date picker", () => {
	it("fills the annual test date from the calendar and sends it as the ISO day", async () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fillRequired({ annualTestDate: "04/01/2027" });
		fireEvent.click(
			screen.getByRole("button", { name: "Choose annual test date" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Thursday, April 15, 2027" }),
		);

		expect(
			screen.getByLabelText<HTMLInputElement>("Annual test date").value,
		).toBe("04/15/2027");

		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ annualTestDate: "2027-04-15" }),
		);
	});
});

describe("EditAssetForm", () => {
	it("starts from the record being edited", () => {
		render(
			<EditAssetForm asset={asset()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
		);

		expect(screen.getByLabelText<HTMLInputElement>("BIN").value).toBe(
			"BIN-10041",
		);
		// An existing asset keeps its saved type selected, not a placeholder.
		expect(screen.getByLabelText("BFA type").textContent).toContain("RP");
		expect(screen.getByLabelText("BFA type").textContent).not.toContain(
			"Select…",
		);
		expect(
			screen.getByLabelText<HTMLInputElement>("Annual test date").value,
		).toBe("04/01/2027");
	});

	it("lets the BIN be corrected — it is editable, not frozen", () => {
		const onSubmit = vi.fn();
		render(
			<EditAssetForm asset={asset()} onSubmit={onSubmit} onCancel={vi.fn()} />,
		);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-20099" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				bin: "BIN-20099",
				annualTestDate: "2027-04-01",
			}),
		);
	});

	it("warns as soon as the BIN changes, while it can still be taken back", () => {
		render(
			<EditAssetForm asset={asset()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
		);

		expect(screen.queryByText(/Changing a BIN is recorded/)).toBeNull();

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-20099" },
		});

		// Names the value being left behind, because that is what the audit line
		// will carry.
		expect(screen.getByRole("status").textContent).toContain(
			"Changing a BIN is recorded",
		);
		expect(screen.getByRole("status").textContent).toContain("BIN-10041");

		// Typing it back is not a change, and the warning goes with it.
		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-10041" },
		});
		expect(screen.queryByText(/Changing a BIN is recorded/)).toBeNull();
	});

	it("has no customer control — an existing occupant moves through its own flow", () => {
		// Changing the occupant of an asset that already has one has to close the
		// outgoing assignment in the same transaction, so it lives on the asset's
		// own page rather than in this form.
		render(
			<EditAssetForm asset={asset()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
		);

		expect(screen.queryByLabelText("Customer")).toBeNull();
	});

	it("never sends a customer, even when the record has one", () => {
		const onSubmit = vi.fn();
		render(
			<EditAssetForm
				asset={asset({ currentCustomerId: "customer-a" })}
				onSubmit={onSubmit}
				onCancel={vi.fn()}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Size"), {
			target: { value: "3 in" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(Object.keys(onSubmit.mock.calls[0]?.[0] ?? {})).not.toContain(
			"currentCustomerId",
		);
	});

	it("shows a form-wide server message above the buttons", () => {
		render(
			<EditAssetForm
				asset={asset()}
				errorMessage="Water Purveyor only"
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"Water Purveyor only",
		);
	});

	it("puts a duplicate-BIN refusal on the BIN field, and clears it when the BIN is edited", () => {
		render(
			<EditAssetForm
				asset={asset()}
				binErrorMessage="BIN BIN-20099 is already in use by another asset"
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		const bin = screen.getByLabelText("BIN");

		// Nothing yet: the message is about the value that was submitted, and
		// nothing has been submitted from this form.
		expect(screen.queryByRole("alert")).toBeNull();

		fireEvent.change(bin, { target: { value: "BIN-20099" } });
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(screen.getByRole("alert").textContent).toContain(
			"already in use by another asset",
		);
		expect(bin.getAttribute("aria-invalid")).toBe("true");
		// The input points at its own message rather than leaving a screen reader
		// to find it.
		expect(bin.getAttribute("aria-describedby")).toBe(
			screen.getByRole("alert").getAttribute("id"),
		);

		// Correcting the BIN is what makes the refusal stale.
		fireEvent.change(bin, { target: { value: "BIN-30100" } });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(bin.getAttribute("aria-invalid")).toBeNull();
	});
});

describe("assetFormErrors", () => {
	it("routes a duplicate BIN to the BIN field", () => {
		expect(
			assetFormErrors({
				message: "BIN BIN-20099 is already in use by another asset",
				data: { code: "CONFLICT" },
			}),
		).toEqual({
			binErrorMessage: "BIN BIN-20099 is already in use by another asset",
		});
	});

	it("routes everything else to the form-wide banner", () => {
		expect(
			assetFormErrors({
				message: "Asset not found",
				data: { code: "NOT_FOUND" },
			}),
		).toEqual({ errorMessage: "Asset not found" });
	});

	it("says nothing when there is no error", () => {
		expect(assetFormErrors(null)).toEqual({});
	});
});
