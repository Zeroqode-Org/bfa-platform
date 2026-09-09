// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildRepairCompanyPayload,
	emptyRepairCompanyValues,
	RepairCompanyForm,
	repairCompanyToFormValues,
} from "./repair-company-form";
import type { RepairCompany } from "./repair-company-types";

/**
 * The repair-company form: what it sends, and what it says about deactivation
 * at the moment it is chosen.
 *
 * The payload builder is exercised directly rather than only through the DOM —
 * it is where a cleared optional field becomes `null` rather than `""` on the
 * client, and that rule has to hold whichever control set it.
 */

function company(overrides: Partial<RepairCompany> = {}): RepairCompany {
	return {
		id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		companyName: "Ridgeline Backflow Repair",
		phone: "555-0142",
		email: "dispatch@ridgeline.example",
		status: "active",
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	};
}

function renderForm(
	props: Partial<Parameters<typeof RepairCompanyForm>[0]> = {},
) {
	const onSubmit = vi.fn();
	const onCancel = vi.fn();

	render(
		<RepairCompanyForm
			submitLabel="Add company"
			pendingLabel="Adding…"
			onSubmit={onSubmit}
			onCancel={onCancel}
			{...props}
		/>,
	);

	return { onSubmit, onCancel };
}

afterEach(() => {
	cleanup();
});

describe("buildRepairCompanyPayload", () => {
	it("trims what it keeps and nulls the optional fields it does not", () => {
		expect(
			buildRepairCompanyPayload({
				...emptyRepairCompanyValues,
				companyName: "  Ridgeline Backflow Repair  ",
				phone: "   ",
				email: "",
			}),
		).toEqual({
			companyName: "Ridgeline Backflow Repair",
			phone: null,
			email: null,
			status: "active",
		});
	});

	it("keeps both contact fields when they are filled in", () => {
		expect(
			buildRepairCompanyPayload({
				companyName: "Ridgeline Backflow Repair",
				phone: " 555-0142 ",
				email: " dispatch@ridgeline.example ",
				status: "inactive",
			}),
		).toEqual({
			companyName: "Ridgeline Backflow Repair",
			phone: "555-0142",
			email: "dispatch@ridgeline.example",
			status: "inactive",
		});
	});

	it("never names a water purveyor", () => {
		// The tenant is the server's to decide, from the caller's own profile.
		expect(
			Object.keys(buildRepairCompanyPayload(emptyRepairCompanyValues)),
		).not.toContain("waterPurveyorId");
	});
});

describe("repairCompanyToFormValues", () => {
	it("turns null columns into empty fields", () => {
		expect(
			repairCompanyToFormValues(company({ phone: null, email: null })),
		).toEqual({
			companyName: "Ridgeline Backflow Repair",
			phone: "",
			email: "",
			status: "active",
		});
	});

	it("round-trips a record with no contact details back to nulls", () => {
		// The edit dialog reads a row in and sends it back out on save; a company
		// reachable by neither column must not acquire two empty strings on the way
		// through.
		expect(
			buildRepairCompanyPayload(
				repairCompanyToFormValues(company({ phone: null, email: null })),
			),
		).toMatchObject({ phone: null, email: null });
	});
});

describe("RepairCompanyForm", () => {
	it("submits the typed values", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Ridgeline Backflow Repair" },
		});
		fireEvent.change(screen.getByLabelText("Phone"), {
			target: { value: "555-0142" },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "dispatch@ridgeline.example" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add company" }));

		expect(onSubmit).toHaveBeenCalledWith({
			companyName: "Ridgeline Backflow Repair",
			phone: "555-0142",
			email: "dispatch@ridgeline.example",
			status: "active",
		});
	});

	it("sends a company with a name alone, and no empty strings behind it", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Name Only Repairs" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add company" }));

		expect(onSubmit).toHaveBeenCalledWith({
			companyName: "Name Only Repairs",
			phone: null,
			email: null,
			status: "active",
		});
	});

	it("requires a company name and leaves the contact fields optional", () => {
		renderForm();

		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).required,
		).toBe(true);
		expect((screen.getByLabelText("Phone") as HTMLInputElement).required).toBe(
			false,
		);
		expect((screen.getByLabelText("Email") as HTMLInputElement).required).toBe(
			false,
		);
	});

	it("starts an edit from the record's own values", () => {
		renderForm({
			initialValues: repairCompanyToFormValues(
				company({ companyName: "Valley Assembly Service", phone: "555-0188" }),
			),
			submitLabel: "Save changes",
		});

		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).value,
		).toBe("Valley Assembly Service");
		expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe(
			"555-0188",
		);
	});

	it("warns what deactivation does at the moment it is chosen", () => {
		renderForm({
			initialValues: { ...emptyRepairCompanyValues, status: "inactive" },
		});

		expect(
			screen.getByText(/stops it appearing in future failure notices/i),
		).toBeTruthy();
	});

	it("says nothing about failure notices while the company is active", () => {
		renderForm();

		expect(
			screen.queryByText(/stops it appearing in future failure notices/i),
		).toBeNull();
	});

	it("switches to inactive from the status select and warns straight away", async () => {
		renderForm();

		fireEvent.click(screen.getByLabelText("Status"));

		// Base UI commits an option on the pointer sequence, not on a bare click.
		const option = await screen.findByRole("option", { name: "Inactive" });
		fireEvent.pointerDown(option);
		fireEvent.pointerUp(option);
		fireEvent.click(option);

		expect(
			await screen.findByText(/stops it appearing in future failure notices/i),
		).toBeTruthy();
	});

	it("disables the controls and relabels the button while the request is in flight", () => {
		renderForm({ pending: true });

		expect(screen.getByRole("button", { name: "Adding…" })).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: "Adding…" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("gives Cancel an explicit button type, so it cannot submit the form", () => {
		const { onSubmit, onCancel } = renderForm();

		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("shows the server's message without clearing what was typed", () => {
		renderForm({
			initialValues: repairCompanyToFormValues(company()),
			errorMessage: "Repair company not found",
		});

		expect(screen.getByRole("alert").textContent).toContain(
			"Repair company not found",
		);
		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).value,
		).toBe("Ridgeline Backflow Repair");
	});
});
