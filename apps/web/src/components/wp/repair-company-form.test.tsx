// @vitest-environment jsdom

import { REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE } from "@bfa-platform/api/lib/email-uniqueness";
import { normalizeUsPhone } from "@bfa-platform/api/lib/us-phone";
import { EMAIL_MESSAGE, PHONE_MESSAGE } from "@bfa-platform/ui/lib/validation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildRepairCompanyPayload,
	emptyRepairCompanyValues,
	RepairCompanyForm,
	repairCompanyFormErrors,
	repairCompanyToFormValues,
} from "./repair-company-form";
import type { RepairCompany } from "./repair-company-types";

/**
 * The repair-company form: what it sends, what it refuses inline before
 * sending, and what it says about deactivation at the moment it is chosen.
 *
 * The payload builder is exercised directly rather than only through the DOM —
 * it is where a cleared optional field becomes `null` rather than `""` on the
 * client, and that rule has to hold whichever control set it.
 */

function company(overrides: Partial<RepairCompany> = {}): RepairCompany {
	return {
		id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		companyName: "Ridgeline Backflow Repair",
		phone: "(555) 014-2233",
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

function submit(label = "Add company") {
	fireEvent.click(screen.getByRole("button", { name: label }));
}

/** Opens the Status select and commits one option. */
function chooseStatus(option: "Active" | "Inactive") {
	fireEvent.click(screen.getByLabelText("Status"));

	// Base UI commits an option on the pointer sequence, not on a bare click.
	const item = screen.getByRole("option", { name: option });
	fireEvent.pointerDown(item);
	fireEvent.pointerUp(item);
	fireEvent.click(item);
}

afterEach(() => {
	cleanup();
});

describe("buildRepairCompanyPayload", () => {
	it("trims what it keeps and nulls the optional fields it does not", () => {
		expect(
			buildRepairCompanyPayload({
				...emptyRepairCompanyValues,
				status: "active",
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

	it("keeps both contact fields, sending a valid phone in its display format", () => {
		expect(
			buildRepairCompanyPayload({
				companyName: "Ridgeline Backflow Repair",
				phone: " 555-123-4567 ",
				email: " dispatch@ridgeline.example ",
				status: "inactive",
			}),
		).toEqual({
			companyName: "Ridgeline Backflow Repair",
			phone: "(555) 123-4567",
			email: "dispatch@ridgeline.example",
			status: "inactive",
		});
	});

	it("never rewrites a phone that is not a valid number", () => {
		expect(
			buildRepairCompanyPayload({
				...emptyRepairCompanyValues,
				companyName: "Legacy Repairs",
				phone: "555-0142",
			}).phone,
		).toBe("555-0142");
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

describe("RepairCompanyForm — phone mask against the server's normalizer", () => {
	/** Names the company, so the phone is the only thing a submit can refuse. */
	function nameCompany() {
		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Parity Repairs" },
		});
		chooseStatus("Active");
	}

	function phoneField() {
		const phone = screen.getByLabelText("Phone") as HTMLInputElement;
		phone.focus();

		return phone;
	}

	it.each([
		"5551234567",
		"+1 555 123 4567",
		"1-555-123-4567",
		"(555) 123-4567",
		"555.123.4567",
		"+1 (212) 555-0199",
	])(
		"masks a pasted %j into the server's canonical spelling and sends it that way",
		(pasted) => {
			const { onSubmit } = renderForm();
			nameCompany();
			const phone = phoneField();

			fireEvent.paste(phone, { clipboardData: { getData: () => pasted } });

			// What the field shows is what the server would store for the same input…
			expect(phone.value).toBe(normalizeUsPhone(pasted));
			// …and re-normalising it changes nothing: the display is already canonical.
			expect(normalizeUsPhone(phone.value)).toBe(phone.value);

			submit();
			expect(onSubmit).toHaveBeenCalledWith(
				expect.objectContaining({ phone: normalizeUsPhone(pasted) }),
			);
		},
	);

	it("leaves an incomplete typed number incomplete, refused by the form and the server alike", () => {
		const { onSubmit } = renderForm();
		nameCompany();
		const phone = phoneField();

		for (const key of "5550142") fireEvent.keyDown(phone, { key });

		expect(phone.value).toBe("(555) 014-2");
		expect(normalizeUsPhone(phone.value)).toBeNull();

		submit();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(PHONE_MESSAGE)).toBeTruthy();
	});

	it("refuses an overflowing paste the server would also refuse, rather than cutting it down", () => {
		renderForm();
		const phone = phoneField();

		fireEvent.paste(phone, { clipboardData: { getData: () => "55512345678" } });

		expect(phone.value).toBe("");
		expect(normalizeUsPhone("55512345678")).toBeNull();
	});

	it("masks only the phone: the email field still takes letters and punctuation", () => {
		renderForm();

		const email = screen.getByLabelText("Email") as HTMLInputElement;
		email.focus();

		expect(fireEvent.keyDown(email, { key: "a" })).toBe(true);
		expect(fireEvent.keyDown(email, { key: "@" })).toBe(true);

		fireEvent.change(email, { target: { value: "dispatch@ridgeline" } });
		expect(email.value).toBe("dispatch@ridgeline");
		expect(email.type).toBe("email");
	});
});

describe("RepairCompanyForm — whole pasted phone values against normalizeUsPhone", () => {
	/**
	 * Whole phone entries a person might paste or autofill. The form and the
	 * server must agree on every one: either both accept it, in the same canonical
	 * spelling, or the server refuses it and the field is left exactly as it was.
	 */
	const ACCEPTED = [
		"5551234567",
		"(555) 123-4567",
		"555-123-4567",
		"555.123.4567",
		"555 123 4567",
		"  (555)123-4567  ",
		"+1 555 123 4567",
		"+15551234567",
		"1-555-123-4567",
		"1 (555) 123-4567",
		"+5551234567",
	];

	const REJECTED = [
		"ph: 555-123-4567",
		"Phone 5551234567",
		"555-CALL-NOW",
		"555-123-4567 x12",
		"555-123-4567 ext. 12",
		"555-123-4567#12",
		"555_123_4567",
		"555/123/4567",
		"+2 555 123 4567",
		"+44 20 7946 0958",
		"++1 555 123 4567",
		"1+555 123 4567",
		"55512345678",
	];

	function pasteInto(phone: HTMLInputElement, text: string) {
		fireEvent.paste(phone, { clipboardData: { getData: () => text } });
	}

	it.each(ACCEPTED)("accepts %j exactly as normalizeUsPhone does", (pasted) => {
		renderForm();
		const phone = screen.getByLabelText("Phone") as HTMLInputElement;
		phone.focus();

		pasteInto(phone, pasted);

		expect(normalizeUsPhone(pasted)).not.toBeNull();
		expect(phone.value).toBe(normalizeUsPhone(pasted));
	});

	it.each(REJECTED)(
		"refuses %j, as normalizeUsPhone does, without touching the field",
		(pasted) => {
			renderForm({
				initialValues: repairCompanyToFormValues(
					company({ phone: "(555) 014-2233" }),
				),
				submitLabel: "Save changes",
			});
			const phone = screen.getByLabelText("Phone") as HTMLInputElement;
			phone.focus();
			phone.setSelectionRange(0, phone.value.length);

			pasteInto(phone, pasted);

			expect(normalizeUsPhone(pasted)).toBeNull();
			expect(phone.value).toBe("(555) 014-2233");
		},
	);

	it("never shows a complete number the server would refuse for the same pasted text", () => {
		for (const pasted of [...ACCEPTED, ...REJECTED]) {
			renderForm();
			const phone = screen.getByLabelText("Phone") as HTMLInputElement;
			phone.focus();

			pasteInto(phone, pasted);

			// A pasted whole value either lands as the server's own answer or
			// leaves the field empty; there is no third outcome.
			expect([normalizeUsPhone(pasted), ""]).toContain(phone.value);
			if (phone.value !== "") {
				expect(phone.value).toBe(normalizeUsPhone(pasted));
			}

			cleanup();
		}
	});
});

describe("repairCompanyFormErrors", () => {
	it("routes a duplicate email to the Email field and everything else to the banner", () => {
		expect(
			repairCompanyFormErrors({
				message: REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE,
				data: { code: "CONFLICT" },
			}),
		).toEqual({ emailErrorMessage: REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE });
		expect(
			repairCompanyFormErrors({
				message: "Repair company not found",
				data: { code: "NOT_FOUND" },
			}),
		).toEqual({ errorMessage: "Repair company not found" });
		expect(repairCompanyFormErrors(null)).toEqual({});
	});
});

describe("RepairCompanyForm — duplicate email refusal", () => {
	it("shows the refusal under the Email field and clears it when the address changes", () => {
		renderForm({
			initialValues: repairCompanyToFormValues(company()),
			submitLabel: "Save changes",
			emailErrorMessage: REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE,
		});

		expect(screen.queryByText(REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE)).toBeNull();

		submit("Save changes");

		const email = screen.getByLabelText("Email");
		const message = screen.getByText(REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE);
		expect(message.getAttribute("role")).toBe("alert");
		expect(message.getAttribute("data-slot")).toBe("field-error");
		expect(email.getAttribute("aria-invalid")).toBe("true");
		expect(email.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.querySelector('[data-slot="form-error"]')).toBeNull();

		fireEvent.change(email, { target: { value: "office@ridgeline.example" } });
		expect(screen.queryByText(REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE)).toBeNull();

		// Same address, another spelling: the server would refuse it too.
		fireEvent.change(email, {
			target: { value: " DISPATCH@ridgeline.example " },
		});
		expect(screen.getByText(REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE)).toBeTruthy();

		// Clearing the optional email is never a duplicate.
		fireEvent.change(email, { target: { value: "" } });
		expect(screen.queryByText(REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE)).toBeNull();
	});
});

describe("RepairCompanyForm", () => {
	it("opts out of browser validation and carries no native constraints", () => {
		renderForm();

		const form = screen
			.getByRole("button", { name: "Add company" })
			.closest("form") as HTMLFormElement;

		expect(form.noValidate).toBe(true);
		expect(form.querySelectorAll("[required]")).toHaveLength(0);
		expect(form.querySelectorAll("[maxlength]")).toHaveLength(0);
	});

	it("shows no errors when it opens", () => {
		renderForm();

		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("opens a new company with the status unanswered", () => {
		renderForm();

		const status = screen.getByLabelText("Status");
		expect(status.textContent).toContain("Select…");
		expect(status.textContent).not.toContain("Active");
		expect(status.hasAttribute("data-placeholder")).toBe(true);
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("blocks a missing status at the field and clears the error once one is chosen", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Ridgeline Backflow Repair" },
		});
		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		const status = screen.getByLabelText("Status");
		const message = screen.getByText("Select a status.");
		expect(message.getAttribute("data-slot")).toBe("field-error");
		expect(status.getAttribute("aria-invalid")).toBe("true");
		expect(status.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.activeElement).toBe(status);

		chooseStatus("Inactive");

		expect(screen.queryByText("Select a status.")).toBeNull();
		expect(status.getAttribute("aria-invalid")).toBeNull();

		submit();
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ status: "inactive" }),
		);
	});

	it("keeps an existing company's status selected", () => {
		renderForm({
			initialValues: repairCompanyToFormValues(company({ status: "inactive" })),
			submitLabel: "Save changes",
		});

		const status = screen.getByLabelText("Status");
		expect(status.textContent).toContain("Inactive");
		expect(status.textContent).not.toContain("Select…");
	});

	it("submits the typed values", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Ridgeline Backflow Repair" },
		});
		fireEvent.change(screen.getByLabelText("Phone"), {
			target: { value: "5551234567" },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "dispatch@ridgeline.example" },
		});
		chooseStatus("Active");
		submit();

		expect(onSubmit).toHaveBeenCalledWith({
			companyName: "Ridgeline Backflow Repair",
			phone: "(555) 123-4567",
			email: "dispatch@ridgeline.example",
			status: "active",
		});
	});

	it("sends a company with a name alone, and no empty strings behind it", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Name Only Repairs" },
		});
		chooseStatus("Active");
		submit();

		expect(onSubmit).toHaveBeenCalledWith({
			companyName: "Name Only Repairs",
			phone: null,
			email: null,
			status: "active",
		});
	});

	it("requires a company name inline, focuses it, and leaves both contact fields optional", () => {
		const { onSubmit } = renderForm();

		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		const name = screen.getByLabelText("Company name");
		const message = screen.getByText("Company name is required.");

		expect(name.getAttribute("aria-invalid")).toBe("true");
		expect(name.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.activeElement).toBe(name);
		// Blank contact fields are a valid record, not two more errors — the
		// only other answer missing is the status nobody has chosen yet.
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual(["Company name is required.", "Select a status."]);
		expect(screen.getByLabelText("Phone").getAttribute("aria-invalid")).toBe(
			null,
		);
		expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
			null,
		);
	});

	it("refuses a phone that is not ten digits, masked but never completed", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Ridgeline Backflow Repair" },
		});
		const phone = screen.getByLabelText("Phone") as HTMLInputElement;
		fireEvent.change(phone, { target: { value: "555-01423" } });
		fireEvent.blur(phone);

		expect(screen.getByText(PHONE_MESSAGE)).toBeTruthy();
		expect(phone.value).toBe("(555) 014-23");

		submit();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(phone);
	});

	it("formats a valid phone as (XXX) XXX-XXXX when the field is left", () => {
		renderForm();

		const phone = screen.getByLabelText("Phone") as HTMLInputElement;
		fireEvent.change(phone, { target: { value: "555.123.4567" } });
		fireEvent.blur(phone);

		expect(phone.value).toBe("(555) 123-4567");
		expect(screen.queryByText(PHONE_MESSAGE)).toBeNull();
	});

	it("asks for a stored phone that is not a valid number to be corrected before saving", () => {
		const { onSubmit } = renderForm({
			initialValues: repairCompanyToFormValues(company({ phone: "555-0142" })),
			submitLabel: "Save changes",
		});

		submit("Save changes");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(PHONE_MESSAGE)).toBeTruthy();
	});

	it("flags an invalid email and clears the message once it is corrected", () => {
		const { onSubmit } = renderForm();

		fireEvent.change(screen.getByLabelText("Company name"), {
			target: { value: "Ridgeline Backflow Repair" },
		});
		const email = screen.getByLabelText("Email");
		fireEvent.change(email, { target: { value: "dispatch@" } });
		submit();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(EMAIL_MESSAGE)).toBeTruthy();

		fireEvent.change(email, {
			target: { value: "dispatch@ridgeline.example" },
		});
		expect(screen.queryByText(EMAIL_MESSAGE)).toBeNull();
		expect(email.getAttribute("aria-invalid")).toBe(null);
	});

	it("starts an edit from the record's own values", () => {
		renderForm({
			initialValues: repairCompanyToFormValues(
				company({
					companyName: "Valley Assembly Service",
					phone: "(555) 018-8000",
				}),
			),
			submitLabel: "Save changes",
		});

		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).value,
		).toBe("Valley Assembly Service");
		expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe(
			"(555) 018-8000",
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

	it("says nothing about failure notices until inactive is chosen", () => {
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

	it("shows the server's message inline without clearing what was typed", () => {
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
