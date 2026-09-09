// @vitest-environment jsdom

import { ASSET_FIELD_LIMITS } from "@bfa-platform/api/lib/asset-field-limits";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AddAssetForm,
	assetFormProblems,
	assetToFormValues,
	buildAssetPayload,
	EditAssetForm,
	emptyAssetValues,
	isCalendarDate,
} from "./asset-form";
import type { Asset } from "./asset-types";
import { assetFormErrors } from "./asset-types";

/**
 * The asset form: what it sends, and what it refuses to carry.
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

afterEach(() => {
	cleanup();
});

describe("buildAssetPayload", () => {
	it("trims what it keeps and nulls the optional fields it does not", () => {
		expect(
			buildAssetPayload({
				...emptyAssetValues,
				bin: "  BIN-10041 ",
				serviceAddress: " 18 Canal Road ",
				make: "   ",
				model: "",
				annualTestDate: "2027-04-01",
			}),
		).toMatchObject({
			bin: "BIN-10041",
			serviceAddress: "18 Canal Road",
			make: null,
			model: null,
		});
	});

	it("names neither the tenant, the status nor the current customer", () => {
		// All three are the server's: the tenant from the caller's profile, the
		// status from the scheduler, and the customer from `assignCustomer`, which
		// records the occupancy change rather than moving a pointer.
		const keys = Object.keys(buildAssetPayload(emptyAssetValues));

		expect(keys).not.toContain("waterPurveyorId");
		expect(keys).not.toContain("assetStatus");
		expect(keys).not.toContain("currentCustomerId");
	});
});

describe("assetToFormValues", () => {
	it("turns null columns into empty fields", () => {
		expect(
			assetToFormValues(
				asset({ make: null, model: null, assemblyLocation: null }),
			),
		).toMatchObject({ make: "", model: "", assemblyLocation: "" });
	});
});

describe("AddAssetForm", () => {
	it("submits the typed values, with the annual test date the schedule needs", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-10041" },
		});
		fireEvent.change(screen.getByLabelText("Service address"), {
			target: { value: "18 Canal Road" },
		});
		fireEvent.change(screen.getByLabelText("Annual test date"), {
			target: { value: "2027-04-01" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add asset" }));

		expect(onSubmit).toHaveBeenCalledWith({
			bin: "BIN-10041",
			bfaType: "RP",
			serviceAddress: "18 Canal Road",
			assemblyLocation: null,
			make: null,
			model: null,
			serialNumber: null,
			size: null,
			annualTestDate: "2027-04-01",
		});
	});

	it("offers no control for the status the scheduler computes", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		expect(screen.queryByLabelText("Status")).toBeNull();
		expect(screen.queryByLabelText(/customer/i)).toBeNull();
	});

	it("keeps save disabled until the three required answers are there", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		const save = screen.getByRole("button", { name: "Add asset" });
		expect(save.hasAttribute("disabled")).toBe(true);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-10041" },
		});
		expect(save.hasAttribute("disabled")).toBe(true);

		fireEvent.change(screen.getByLabelText("Service address"), {
			target: { value: "18 Canal Road" },
		});
		expect(save.hasAttribute("disabled")).toBe(true);

		fireEvent.change(screen.getByLabelText("Annual test date"), {
			target: { value: "2027-04-01" },
		});
		expect(save.hasAttribute("disabled")).toBe(false);
	});

	it("treats a BIN of only spaces as empty, the way the server does", () => {
		const onSubmit = vi.fn();
		render(<AddAssetForm onSubmit={onSubmit} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "   " },
		});
		fireEvent.change(screen.getByLabelText("Service address"), {
			target: { value: "18 Canal Road" },
		});
		fireEvent.change(screen.getByLabelText("Annual test date"), {
			target: { value: "2027-04-01" },
		});

		const save = screen.getByRole("button", { name: "Add asset" });
		expect(save.hasAttribute("disabled")).toBe(true);

		// And a submit that reaches the handler anyway sends nothing.
		fireEvent.submit(save.closest("form") as HTMLFormElement);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("refuses a date that is not a real calendar day", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-10041" },
		});
		fireEvent.change(screen.getByLabelText("Service address"), {
			target: { value: "18 Canal Road" },
		});
		// 31 February parses to 3 March if nothing checks — a reminder that would
		// fire on a day nobody chose.
		fireEvent.change(screen.getByLabelText("Annual test date"), {
			target: { value: "2027-02-31" },
		});

		expect(
			screen
				.getByRole("button", { name: "Add asset" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("stops typing at the length the API schema accepts", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		// The numbers come from the same module the Zod shapes are built from, so
		// this asserts they are wired up, not that they are any particular value.
		expect(screen.getByLabelText("BIN").getAttribute("maxlength")).toBe(
			String(ASSET_FIELD_LIMITS.bin),
		);
		expect(
			screen.getByLabelText("Service address").getAttribute("maxlength"),
		).toBe(String(ASSET_FIELD_LIMITS.serviceAddress));
		expect(screen.getByLabelText("Make").getAttribute("maxlength")).toBe(
			String(ASSET_FIELD_LIMITS.make),
		);
		expect(screen.getByLabelText("Size").getAttribute("maxlength")).toBe(
			String(ASSET_FIELD_LIMITS.size),
		);
	});

	it("does not warn about a BIN change on a record that has no old BIN", () => {
		render(<AddAssetForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("BIN"), {
			target: { value: "BIN-10041" },
		});

		expect(screen.queryByText(/Changing a BIN is recorded/)).toBeNull();
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
		expect(
			screen.getByLabelText<HTMLInputElement>("Annual test date").value,
		).toBe("2027-04-01");
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
			expect.objectContaining({ bin: "BIN-20099" }),
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

describe("isCalendarDate", () => {
	it("accepts a real day and refuses one that only looks like a date", () => {
		expect(isCalendarDate("2027-04-01")).toBe(true);
		expect(isCalendarDate("2028-02-29")).toBe(true);
		expect(isCalendarDate("2027-02-29")).toBe(false);
		expect(isCalendarDate("2027-13-01")).toBe(false);
		expect(isCalendarDate("")).toBe(false);
		expect(isCalendarDate("next April")).toBe(false);
	});
});

describe("assetFormProblems", () => {
	it("names the three required answers, on the trimmed values", () => {
		expect(
			assetFormProblems({
				...emptyAssetValues,
				bin: "  ",
				serviceAddress: "18 Canal Road",
			}),
		).toEqual({ bin: true, serviceAddress: false, annualTestDate: true });
	});
});
