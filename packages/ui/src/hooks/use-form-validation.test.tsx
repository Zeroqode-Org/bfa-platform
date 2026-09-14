// @vitest-environment jsdom

import { DateInput } from "@bfa-platform/ui/components/date-input";
import { FieldError } from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { PhoneInput } from "@bfa-platform/ui/components/phone-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bfa-platform/ui/components/select";
import {
	composeRules,
	DATE_MESSAGE,
	EMAIL_MESSAGE,
	email,
	PHONE_MESSAGE,
	required,
	usDate,
	usPhone,
} from "@bfa-platform/ui/lib/validation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFormValidation } from "./use-form-validation";

/**
 * The shared inline-validation hook, driven through a small form that uses
 * each control family the app has: a text input, a phone input, a date input
 * and a Base UI select trigger.
 */

type Values = {
	email: string;
	phone: string;
	date: string;
	kind: string;
};

const EMPTY: Values = { email: "", phone: "", date: "", kind: "" };

function Harness({
	onValid,
	externalEmailError,
}: {
	onValid: (values: Values) => void;
	externalEmailError?: string;
}) {
	const [values, setValues] = useState(EMPTY);
	const validation = useFormValidation({
		values,
		rules: {
			email: composeRules(required("Email is required."), email()),
			phone: usPhone(),
			date: composeRules(required("Date is required."), usDate()),
			kind: required("Choose a kind."),
		},
		externalErrors: { email: externalEmailError },
	});

	function update(field: keyof Values, value: string) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				if (validation.validate()) onValid(values);
			}}
		>
			<Label htmlFor={validation.fieldId("email")}>Email</Label>
			<Input
				{...validation.controlProps("email")}
				type="email"
				value={values.email}
				onChange={(event) => update("email", event.target.value)}
			/>
			<FieldError {...validation.errorProps("email")} />

			<Label htmlFor={validation.fieldId("phone")}>Phone</Label>
			<PhoneInput
				{...validation.controlProps("phone")}
				value={values.phone}
				onValueChange={(value) => update("phone", value)}
			/>
			<FieldError {...validation.errorProps("phone")} />

			<Label htmlFor={validation.fieldId("date")}>Date</Label>
			<DateInput
				{...validation.controlProps("date", { describedBy: "date-hint" })}
				value={values.date}
				onValueChange={(value) => update("date", value)}
			/>
			<p id="date-hint">When it happened.</p>
			<FieldError {...validation.errorProps("date")} />

			<Label htmlFor={validation.fieldId("kind")}>Kind</Label>
			<Select
				items={{ a: "Kind A", b: "Kind B" }}
				value={values.kind || null}
				onValueChange={(value) => update("kind", String(value ?? ""))}
			>
				<SelectTrigger {...validation.controlProps("kind")}>
					<SelectValue placeholder="Select…" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">Kind A</SelectItem>
					<SelectItem value="b">Kind B</SelectItem>
				</SelectContent>
			</Select>
			<FieldError {...validation.errorProps("kind")} />

			<button type="submit">Save</button>
		</form>
	);
}

function renderHarness(props: { externalEmailError?: string } = {}) {
	const onValid = vi.fn();
	render(<Harness onValid={onValid} {...props} />);

	return { onValid };
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

afterEach(() => {
	cleanup();
});

describe("useFormValidation", () => {
	it("shows nothing when the form opens", () => {
		renderHarness();

		expect(screen.queryAllByRole("alert")).toHaveLength(0);
		expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
			null,
		);
	});

	it("does not flag a field that was only tabbed through", () => {
		renderHarness();

		const input = screen.getByLabelText("Email");
		fireEvent.focus(input);
		fireEvent.blur(input);

		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("reveals every failing field on submit, sends nothing, and focuses the first", () => {
		const { onValid } = renderHarness();

		submit();

		expect(onValid).not.toHaveBeenCalled();
		const messages = screen
			.getAllByRole("alert")
			.map((node) => node.textContent);
		expect(messages).toEqual([
			"Email is required.",
			"Date is required.",
			"Choose a kind.",
		]);
		expect(document.activeElement).toBe(screen.getByLabelText("Email"));
	});

	it("links each invalid control to its own message", () => {
		renderHarness();

		submit();

		const input = screen.getByLabelText("Email");
		const message = screen.getByText("Email is required.");

		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe(message.id);
	});

	it("keeps an existing description alongside the error", () => {
		renderHarness();

		submit();

		const date = screen.getByLabelText("Date");
		const message = screen.getByText("Date is required.");
		expect(date.getAttribute("aria-describedby")).toBe(
			`${message.id} date-hint`,
		);
	});

	it("marks a custom select trigger invalid and links its message", () => {
		renderHarness();

		submit();

		const trigger = screen.getByLabelText("Kind");
		expect(trigger.getAttribute("aria-invalid")).toBe("true");
		expect(trigger.getAttribute("aria-describedby")).toBe(
			screen.getByText("Choose a kind.").id,
		);
	});

	it("moves focus to the first invalid field in document order, not rule order", () => {
		renderHarness();

		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "tester@example.com" },
		});
		submit();

		expect(document.activeElement).toBe(screen.getByLabelText("Date"));
	});

	it("revalidates while the person corrects a field and clears the message when it is right", () => {
		renderHarness();

		submit();
		const input = screen.getByLabelText("Email");

		fireEvent.change(input, { target: { value: "tester@" } });
		expect(screen.getByText(EMAIL_MESSAGE)).toBeTruthy();

		fireEvent.change(input, { target: { value: "tester@example.com" } });
		expect(screen.queryByText(EMAIL_MESSAGE)).toBeNull();
		expect(input.getAttribute("aria-invalid")).toBe(null);
		expect(input.getAttribute("aria-describedby")).toBe(null);
	});

	it("reveals a changed field's problem when the person leaves it", () => {
		renderHarness();

		const input = screen.getByLabelText("Email");
		fireEvent.change(input, { target: { value: "tester@" } });
		expect(screen.queryByText(EMAIL_MESSAGE)).toBeNull();

		fireEvent.blur(input);
		expect(screen.getByText(EMAIL_MESSAGE)).toBeTruthy();
	});

	it("leaves an optional phone blank without complaint, but refuses a short number", () => {
		renderHarness();

		submit();
		expect(screen.queryByText(PHONE_MESSAGE)).toBeNull();

		const phone = screen.getByLabelText("Phone");
		fireEvent.change(phone, { target: { value: "555-0142" } });
		fireEvent.blur(phone);

		expect(screen.getByText(PHONE_MESSAGE)).toBeTruthy();
		// Masked, but never completed: the seven digits entered are still all there.
		expect((phone as HTMLInputElement).value).toBe("(555) 014-2");
	});

	it("formats a valid phone number on blur", () => {
		renderHarness();

		const phone = screen.getByLabelText("Phone") as HTMLInputElement;
		fireEvent.change(phone, { target: { value: "555.123.4567" } });
		fireEvent.blur(phone);

		expect(phone.value).toBe("(555) 123-4567");
		expect(screen.queryByText(PHONE_MESSAGE)).toBeNull();
	});

	it("refuses an impossible calendar date and normalises a real one", () => {
		renderHarness();

		const date = screen.getByLabelText("Date") as HTMLInputElement;
		fireEvent.change(date, { target: { value: "02/30/2026" } });
		fireEvent.blur(date);
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();

		fireEvent.change(date, { target: { value: "2/3/2027" } });
		fireEvent.blur(date);
		expect(date.value).toBe("02/03/2027");
		expect(screen.queryByText(DATE_MESSAGE)).toBeNull();
	});

	it("submits once every field is valid", () => {
		const { onValid } = renderHarness();

		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "tester@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Date"), {
			target: { value: "04/01/2027" },
		});
		submit();
		expect(onValid).not.toHaveBeenCalled();

		fireEvent.click(screen.getByLabelText("Kind"));
		const option = screen.getByRole("option", { name: "Kind B" });
		fireEvent.pointerDown(option);
		fireEvent.pointerUp(option);
		fireEvent.click(option);
		submit();

		expect(onValid).toHaveBeenCalledWith({
			email: "tester@example.com",
			phone: "",
			date: "04/01/2027",
			kind: "b",
		});
	});

	it("renders a server error at its field with the same wiring", () => {
		renderHarness({ externalEmailError: "That address is already invited." });

		const input = screen.getByLabelText("Email");
		const message = screen.getByRole("alert");

		expect(message.textContent).toBe("That address is already invited.");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe(message.id);
	});
});
