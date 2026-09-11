// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildCustomerPayload,
	CustomerForm,
	customerToFormValues,
	emptyCustomerValues,
} from "./customer-form";
import type { Customer } from "./customer-types";

/**
 * The customer form: what it sends, and when the agricultural renewal date
 * appears at all.
 *
 * The payload builder is exercised directly rather than only through the DOM —
 * it is where the rule that a standard customer carries no renewal date lives
 * on the client, and that rule has to hold whichever control set it.
 */

function customer(overrides: Partial<Customer> = {}): Customer {
	return {
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
		...overrides,
	};
}

function renderForm(props: Partial<Parameters<typeof CustomerForm>[0]> = {}) {
	const onSubmit = vi.fn();
	const onCancel = vi.fn();

	render(
		<CustomerForm
			submitLabel="Add customer"
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

describe("buildCustomerPayload", () => {
	it("sends no renewal date for a standard customer", () => {
		expect(
			buildCustomerPayload({
				...emptyCustomerValues,
				name: "Marta Ellison",
				email: "marta@example.com",
				// Left over from a moment on the agricultural rate — dropped, because
				// the server refuses a date on a standard customer.
				agRenewalDate: "2027-03-01",
			}),
		).toMatchObject({ rateCategory: "standard", agRenewalDate: null });
	});

	it("keeps the renewal date for an agricultural customer", () => {
		expect(
			buildCustomerPayload({
				...emptyCustomerValues,
				name: "Ridgeline Orchards",
				email: "billing@ridgeline.example",
				rateCategory: "agricultural",
				agRenewalDate: "2027-03-01",
			}),
		).toMatchObject({
			rateCategory: "agricultural",
			agRenewalDate: "2027-03-01",
		});
	});

	it("trims what it keeps and nulls the optional fields it does not", () => {
		expect(
			buildCustomerPayload({
				...emptyCustomerValues,
				name: "  Marta Ellison  ",
				email: "  marta@example.com ",
				accountNumber: "   ",
				address: "",
			}),
		).toMatchObject({
			name: "Marta Ellison",
			email: "marta@example.com",
			accountNumber: null,
			address: null,
		});
	});

	it("never names a water purveyor", () => {
		// The tenant is the server's to decide, from the caller's own profile.
		expect(
			Object.keys(buildCustomerPayload(emptyCustomerValues)),
		).not.toContain("waterPurveyorId");
	});
});

describe("customerToFormValues", () => {
	it("turns null columns into empty fields", () => {
		expect(
			customerToFormValues(
				customer({ accountNumber: null, address: null, agRenewalDate: null }),
			),
		).toMatchObject({ accountNumber: "", address: "", agRenewalDate: "" });
	});
});

describe("CustomerForm", () => {
	it("submits the typed values as a standard customer", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Marta Ellison" },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "marta@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Account number"), {
			target: { value: "AC-4471" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		expect(onSubmit).toHaveBeenCalledWith({
			name: "Marta Ellison",
			email: "marta@example.com",
			accountNumber: "AC-4471",
			address: null,
			rateCategory: "standard",
			agRenewalDate: null,
			status: "active",
		});
	});

	it("hides the AG renewal date on the standard rate", () => {
		renderForm();

		expect(screen.queryByLabelText("AG renewal date")).toBeNull();
	});

	it("reveals the AG renewal date as soon as the agricultural rate is chosen", async () => {
		renderForm();

		fireEvent.click(screen.getByLabelText("Rate category"));

		// Base UI commits an option on the pointer sequence, not on a bare click.
		const option = await screen.findByRole("option", { name: "Agricultural" });
		fireEvent.pointerDown(option);
		fireEvent.pointerUp(option);
		fireEvent.click(option);

		expect(await screen.findByLabelText("AG renewal date")).toBeTruthy();
	});

	it("shows the AG renewal date, required, on the agricultural rate", () => {
		renderForm({
			initialValues: customerToFormValues(
				customer({ rateCategory: "agricultural", agRenewalDate: "2027-03-01" }),
			),
		});

		const field = screen.getByLabelText("AG renewal date") as HTMLInputElement;

		expect(field.value).toBe("2027-03-01");
		expect(field.required).toBe(true);
	});

	it("submits an agricultural customer with its renewal date", () => {
		const { onSubmit } = renderForm({
			initialValues: customerToFormValues(
				customer({
					name: "Ridgeline Orchards",
					email: "billing@ridgeline.example",
					rateCategory: "agricultural",
					agRenewalDate: "2027-03-01",
				}),
			),
			submitLabel: "Save changes",
		});

		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				rateCategory: "agricultural",
				agRenewalDate: "2027-03-01",
			}),
		);
	});

	it("warns what suspension does at the moment it is chosen", () => {
		renderForm({
			initialValues: { ...emptyCustomerValues, status: "suspended" },
		});

		expect(
			screen.getByText(/pauses all automated email/i).textContent,
		).toContain("currently assigned assets");
	});

	it("says nothing about paused email while the customer is active", () => {
		renderForm();

		expect(screen.queryByText(/pauses all automated email/i)).toBeNull();
	});

	it("disables the controls and relabels the button while the request is in flight", () => {
		renderForm({ pending: true });

		expect(screen.getByRole("button", { name: "Adding…" })).toBeTruthy();
		expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(
			true,
		);
		expect(
			(screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("shows the server's message without clearing what was typed", () => {
		renderForm({
			initialValues: customerToFormValues(customer()),
			errorMessage: "Customer not found",
		});

		expect(screen.getByRole("alert").textContent).toContain(
			"Customer not found",
		);
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
			"Marta Ellison",
		);
	});
});
