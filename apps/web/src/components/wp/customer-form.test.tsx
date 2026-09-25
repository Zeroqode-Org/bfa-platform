// @vitest-environment jsdom

import { CUSTOMER_STALE_MESSAGE } from "@bfa-platform/api/lib/customer-revision";
import { CUSTOMER_EMAIL_TAKEN_MESSAGE } from "@bfa-platform/api/lib/email-uniqueness";
import { DATE_MESSAGE, EMAIL_MESSAGE } from "@bfa-platform/ui/lib/validation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildCustomerPayload,
	CustomerForm,
	customerFormErrors,
	customerToFormValues,
	emptyCustomerValues,
	isCompletedCustomer,
} from "./customer-form";
import type { Customer } from "./customer-types";

/**
 * The customer form: what it sends, what it refuses inline before sending, when
 * the agricultural renewal date appears at all, and where a duplicate email
 * refusal from the server is shown.
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

/** Opens a select by its label and commits one option. */
function choose(label: string, option: string) {
	fireEvent.click(screen.getByLabelText(label));

	// Base UI commits an option on the pointer sequence, not on a bare click.
	const item = screen.getByRole("option", { name: option });
	fireEvent.pointerDown(item);
	fireEvent.pointerUp(item);
	fireEvent.click(item);
}

function fillNewCustomer({
	name = "Marta Ellison",
	email = "marta@example.com",
	rate = "Standard",
	status = "Active",
}: {
	name?: string;
	email?: string;
	rate?: string | null;
	status?: string | null;
} = {}) {
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: email },
	});
	if (rate) choose("Rate category", rate);
	if (status) choose("Status", status);
}

function submit(label = "Add customer") {
	fireEvent.click(screen.getByRole("button", { name: label }));
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
				rateCategory: "standard",
				status: "active",
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
				status: "active",
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
				rateCategory: "standard",
				status: "active",
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
			Object.keys(buildCustomerPayload(customerToFormValues(customer()))),
		).not.toContain("waterPurveyorId");
	});
});

describe("isCompletedCustomer", () => {
	it("is false until both selects hold a real choice", () => {
		expect(isCompletedCustomer(emptyCustomerValues)).toBe(false);
		expect(
			isCompletedCustomer({ ...emptyCustomerValues, rateCategory: "standard" }),
		).toBe(false);
		expect(
			isCompletedCustomer({
				...emptyCustomerValues,
				rateCategory: "standard",
				status: "active",
			}),
		).toBe(true);
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

describe("customerFormErrors", () => {
	it("routes a duplicate email to the Email field", () => {
		expect(
			customerFormErrors({
				message: CUSTOMER_EMAIL_TAKEN_MESSAGE,
				data: { code: "CONFLICT" },
			}),
		).toEqual({ emailErrorMessage: CUSTOMER_EMAIL_TAKEN_MESSAGE });
	});

	it("routes a stale record to the form-wide message, not to Email", () => {
		// Same `CONFLICT` code, a different failure: the whole record moved on
		// under the open form — most often the AG renewal notice's annual
		// transition — so there is no field to correct.
		expect(
			customerFormErrors({
				message: CUSTOMER_STALE_MESSAGE,
				data: { code: "CONFLICT" },
			}),
		).toEqual({ errorMessage: CUSTOMER_STALE_MESSAGE });
	});

	it("routes everything else to the form-wide message", () => {
		expect(
			customerFormErrors({
				message: "Customer not found",
				data: { code: "NOT_FOUND" },
			}),
		).toEqual({ errorMessage: "Customer not found" });
		expect(customerFormErrors(null)).toEqual({});
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
		expect(form.querySelectorAll("select")).toHaveLength(0);
	});

	it("opens a new customer with both selects unanswered", () => {
		renderForm();

		for (const label of ["Rate category", "Status"]) {
			const trigger = screen.getByLabelText(label);
			expect(trigger.textContent).toContain("Select…");
			expect(trigger.hasAttribute("data-placeholder")).toBe(true);
		}
		expect(screen.getByLabelText("Rate category").textContent).not.toContain(
			"Standard",
		);
		expect(screen.getByLabelText("Status").textContent).not.toContain("Active");
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("submits the typed values once a rate and a status are chosen", () => {
		const { onSubmit } = renderForm();

		fillNewCustomer();
		fireEvent.change(screen.getByLabelText("Account number"), {
			target: { value: "AC-4471" },
		});
		submit();

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

		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual([
			"Name is required.",
			"Email is required.",
			"Select a rate category.",
			"Select a status.",
		]);

		const name = screen.getByLabelText("Name");
		expect(document.activeElement).toBe(name);
		expect(name.getAttribute("aria-invalid")).toBe("true");
		expect(name.getAttribute("aria-describedby")).toBe(
			screen.getByText("Name is required.").id,
		);
	});

	it("blocks an unanswered select at the field and clears the error once a choice is made", () => {
		const { onSubmit } = renderForm();

		fillNewCustomer({ rate: null, status: "Active" });
		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		const trigger = screen.getByLabelText("Rate category");
		const message = screen.getByText("Select a rate category.");
		expect(trigger.getAttribute("aria-invalid")).toBe("true");
		expect(trigger.getAttribute("aria-describedby")).toBe(message.id);
		expect(message.getAttribute("data-slot")).toBe("field-error");
		expect(document.activeElement).toBe(trigger);

		choose("Rate category", "Agricultural");

		expect(screen.queryByText("Select a rate category.")).toBeNull();
		expect(trigger.getAttribute("aria-invalid")).toBeNull();
	});

	it("refuses an invalid email and clears the message as soon as it is corrected", () => {
		const { onSubmit } = renderForm();

		fillNewCustomer({ email: "marta@example" });
		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(EMAIL_MESSAGE)).toBeTruthy();
		expect(document.activeElement).toBe(screen.getByLabelText("Email"));

		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "marta@example.com" },
		});
		expect(screen.queryByText(EMAIL_MESSAGE)).toBeNull();

		submit();
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("hides the AG renewal date until the agricultural rate is chosen", () => {
		renderForm();

		expect(screen.queryByLabelText("AG renewal date")).toBeNull();

		choose("Rate category", "Standard");
		expect(screen.queryByLabelText("AG renewal date")).toBeNull();

		choose("Rate category", "Agricultural");
		expect(screen.getByLabelText("AG renewal date")).toBeTruthy();
	});

	it("keeps an existing customer's rate and status selected", () => {
		renderForm({
			initialValues: customerToFormValues(
				customer({ rateCategory: "agricultural", agRenewalDate: "2027-03-01" }),
			),
			submitLabel: "Save changes",
		});

		const rate = screen.getByLabelText("Rate category");
		const status = screen.getByLabelText("Status");
		expect(rate.textContent).toContain("Agricultural");
		expect(status.textContent).toContain("Active");
		expect(rate.textContent).not.toContain("Select…");
		expect(status.textContent).not.toContain("Select…");

		const field = screen.getByLabelText("AG renewal date") as HTMLInputElement;
		expect(field.value).toBe("03/01/2027");
		expect(field.getAttribute("aria-required")).toBe("true");
	});

	it("requires the renewal date only once the agricultural rate is chosen", () => {
		const { onSubmit } = renderForm();

		fillNewCustomer({ rate: "Agricultural" });
		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText("AG renewal date is required.")).toBeTruthy();
		expect(document.activeElement).toBe(
			screen.getByLabelText("AG renewal date"),
		);
	});

	it("refuses an impossible renewal date", () => {
		const { onSubmit } = renderForm();

		fillNewCustomer({ rate: "Agricultural" });
		const date = screen.getByLabelText("AG renewal date");
		fireEvent.change(date, { target: { value: "02/30/2026" } });
		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();

		fireEvent.change(date, { target: { value: "02/28/2027" } });
		submit();

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				rateCategory: "agricultural",
				agRenewalDate: "2027-02-28",
			}),
		);
	});

	it("submits an existing agricultural customer with its renewal date", () => {
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

		submit("Save changes");

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				rateCategory: "agricultural",
				agRenewalDate: "2027-03-01",
				status: "active",
			}),
		);
	});

	it("warns what suspension does at the moment it is chosen", () => {
		renderForm();

		expect(screen.queryByText(/pauses all automated email/i)).toBeNull();

		choose("Status", "Suspended");

		expect(
			screen.getByText(/pauses all automated email/i).textContent,
		).toContain("currently assigned assets");
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

describe("CustomerForm — duplicate email refusal", () => {
	it("shows the refusal under the Email field with the shared inline error, not the form banner", () => {
		const { onSubmit } = renderForm({
			initialValues: customerToFormValues(customer()),
			submitLabel: "Save changes",
			emailErrorMessage: CUSTOMER_EMAIL_TAKEN_MESSAGE,
		});

		// Nothing yet: the refusal is about an address that has been submitted.
		expect(screen.queryByText(CUSTOMER_EMAIL_TAKEN_MESSAGE)).toBeNull();

		submit("Save changes");
		expect(onSubmit).toHaveBeenCalledTimes(1);

		const email = screen.getByLabelText("Email");
		const message = screen.getByText(CUSTOMER_EMAIL_TAKEN_MESSAGE);

		expect(message.getAttribute("role")).toBe("alert");
		expect(message.getAttribute("data-slot")).toBe("field-error");
		expect(email.getAttribute("aria-invalid")).toBe("true");
		expect(email.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.querySelector('[data-slot="form-error"]')).toBeNull();
	});

	it("clears when the address changes, and returns for the same address in another spelling", () => {
		renderForm({
			initialValues: customerToFormValues(customer()),
			submitLabel: "Save changes",
			emailErrorMessage: CUSTOMER_EMAIL_TAKEN_MESSAGE,
		});

		submit("Save changes");
		const email = screen.getByLabelText("Email");

		fireEvent.change(email, { target: { value: "marta.ellison@example.com" } });
		expect(screen.queryByText(CUSTOMER_EMAIL_TAKEN_MESSAGE)).toBeNull();
		expect(email.getAttribute("aria-invalid")).toBeNull();

		// The server compares trimmed, lowercased addresses — so does the form.
		fireEvent.change(email, { target: { value: "  MARTA@Example.com " } });
		expect(screen.getByText(CUSTOMER_EMAIL_TAKEN_MESSAGE)).toBeTruthy();
	});
});
