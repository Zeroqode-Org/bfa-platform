// @vitest-environment jsdom

import { DATE_MESSAGE, EMAIL_MESSAGE } from "@bfa-platform/ui/lib/validation";
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
 * The customer form: what it sends, what it refuses inline before sending, and
 * when the agricultural renewal date appears at all.
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

async function chooseAgricultural() {
	fireEvent.click(screen.getByLabelText("Rate category"));

	// Base UI commits an option on the pointer sequence, not on a bare click.
	const option = await screen.findByRole("option", { name: "Agricultural" });
	fireEvent.pointerDown(option);
	fireEvent.pointerUp(option);
	fireEvent.click(option);

	return screen.findByLabelText("AG renewal date");
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
				agRenewalDate: "03/01/2027",
			}),
		).toMatchObject({ rateCategory: "standard", agRenewalDate: null });
	});

	it("sends an agricultural customer's MM/DD/YYYY renewal date as the API's ISO day", () => {
		expect(
			buildCustomerPayload({
				...emptyCustomerValues,
				name: "Ridgeline Orchards",
				email: "billing@ridgeline.example",
				rateCategory: "agricultural",
				agRenewalDate: "03/01/2027",
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

	it("shows a stored renewal date as MM/DD/YYYY", () => {
		expect(
			customerToFormValues(
				customer({ rateCategory: "agricultural", agRenewalDate: "2027-03-01" }),
			).agRenewalDate,
		).toBe("03/01/2027");
	});
});

describe("CustomerForm", () => {
	it("opts out of browser validation and carries no native constraints", () => {
		renderForm({
			initialValues: customerToFormValues(
				customer({ rateCategory: "agricultural", agRenewalDate: "2027-03-01" }),
			),
		});

		const form = screen
			.getByRole("button", { name: "Add customer" })
			.closest("form") as HTMLFormElement;

		expect(form.noValidate).toBe(true);
		expect(form.querySelectorAll("[required]")).toHaveLength(0);
		expect(form.querySelectorAll('input[type="date"]')).toHaveLength(0);
	});

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

	it("shows nothing until submitted, then names each missing answer and focuses the first", () => {
		const { onSubmit } = renderForm();

		expect(screen.queryAllByRole("alert")).toHaveLength(0);

		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual(["Name is required.", "Email is required."]);

		const name = screen.getByLabelText("Name");
		expect(document.activeElement).toBe(name);
		expect(name.getAttribute("aria-invalid")).toBe("true");
		expect(name.getAttribute("aria-describedby")).toBe(
			screen.getByText("Name is required.").id,
		);
	});

	it("refuses an invalid email and clears the message as soon as it is corrected", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Marta Ellison" },
		});
		const email = screen.getByLabelText("Email");
		fireEvent.change(email, { target: { value: "marta@example" } });
		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(EMAIL_MESSAGE)).toBeTruthy();
		expect(document.activeElement).toBe(email);

		fireEvent.change(email, { target: { value: "marta@example.com" } });
		expect(screen.queryByText(EMAIL_MESSAGE)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("hides the AG renewal date on the standard rate", () => {
		renderForm();

		expect(screen.queryByLabelText("AG renewal date")).toBeNull();
	});

	it("reveals the AG renewal date as soon as the agricultural rate is chosen", async () => {
		renderForm();

		expect(await chooseAgricultural()).toBeTruthy();
	});

	it("shows the AG renewal date as MM/DD/YYYY on the agricultural rate", () => {
		renderForm({
			initialValues: customerToFormValues(
				customer({ rateCategory: "agricultural", agRenewalDate: "2027-03-01" }),
			),
		});

		const field = screen.getByLabelText("AG renewal date") as HTMLInputElement;

		expect(field.value).toBe("03/01/2027");
		expect(field.getAttribute("aria-required")).toBe("true");
	});

	it("requires the renewal date only once the agricultural rate is chosen", async () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Ridgeline Orchards" },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "billing@ridgeline.example" },
		});

		const date = await chooseAgricultural();
		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("AG renewal date is required.")).toBeTruthy();
		expect(document.activeElement).toBe(date);
	});

	it("refuses an impossible renewal date", async () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Ridgeline Orchards" },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "billing@ridgeline.example" },
		});
		const date = await chooseAgricultural();
		fireEvent.change(date, { target: { value: "02/30/2026" } });
		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();

		fireEvent.change(date, { target: { value: "02/28/2027" } });
		fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				rateCategory: "agricultural",
				agRenewalDate: "2027-02-28",
			}),
		);
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

	it("shows the server's message inline without clearing what was typed", () => {
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
