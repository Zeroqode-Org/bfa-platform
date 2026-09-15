// @vitest-environment jsdom

import { FieldError } from "@bfa-platform/ui/components/field-message";
import { Label } from "@bfa-platform/ui/components/label";
import { PhoneInput } from "@bfa-platform/ui/components/phone-input";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	formatUsPhone,
	PHONE_MESSAGE,
	usPhone,
} from "@bfa-platform/ui/lib/validation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The shared phone field: the `(XXX) XXX-XXXX` mask, wired to the shared inline
 * validation the way the repair-company form uses it.
 */

function Harness({ initial = "" }: { initial?: string }) {
	const [value, setValue] = useState(initial);
	const validation = useFormValidation({
		values: { phone: value },
		rules: { phone: usPhone() },
	});

	return (
		<form noValidate>
			<Label htmlFor={validation.fieldId("phone")}>Phone</Label>
			<PhoneInput
				{...validation.controlProps("phone")}
				value={value}
				onValueChange={setValue}
			/>
			<FieldError {...validation.errorProps("phone")} />
		</form>
	);
}

function field() {
	return screen.getByLabelText("Phone") as HTMLInputElement;
}

function placeCaret(start: number, end = start) {
	const input = field();
	input.focus();
	input.setSelectionRange(start, end);

	return input;
}

function type(text: string) {
	for (const key of text) fireEvent.keyDown(field(), { key });
}

function caret() {
	return [field().selectionStart, field().selectionEnd];
}

function paste(text: string) {
	fireEvent.paste(field(), { clipboardData: { getData: () => text } });
}

afterEach(() => {
	cleanup();
});

describe("PhoneInput — (XXX) XXX-XXXX mask", () => {
	it("stays a tel input with a phone keypad and no native constraints", () => {
		render(<Harness />);

		expect(field().type).toBe("tel");
		expect(field().inputMode).toBe("tel");
		expect(field().hasAttribute("maxlength")).toBe(false);
		expect(field().hasAttribute("pattern")).toBe(false);
	});

	it("formats while typing, adding the separators as each group completes", () => {
		render(<Harness />);
		placeCaret(0);

		const steps: [string, string][] = [
			["5", "(5"],
			["5", "(55"],
			["5", "(555) "],
			["1", "(555) 1"],
			["2", "(555) 12"],
			["3", "(555) 123-"],
			["4", "(555) 123-4"],
			["5", "(555) 123-45"],
			["6", "(555) 123-456"],
			["7", "(555) 123-4567"],
		];

		for (const [key, expected] of steps) {
			type(key);
			expect(field().value).toBe(expected);
			expect(caret()).toEqual([expected.length, expected.length]);
		}

		fireEvent.blur(field());
		expect(screen.queryByText(PHONE_MESSAGE)).toBeNull();
	});

	it("refuses letters and punctuation from the keyboard, and stops at ten digits", () => {
		render(<Harness initial="(555) 123-456" />);
		placeCaret(13);

		for (const key of ["a", "x", "+", "(", ")", "-", ".", " ", "#"]) {
			// `false` means the keystroke was cancelled rather than merely ignored.
			expect(fireEvent.keyDown(field(), { key })).toBe(false);
			expect(field().value).toBe("(555) 123-456");
		}

		type("7");
		expect(field().value).toBe("(555) 123-4567");

		expect(fireEvent.keyDown(field(), { key: "8" })).toBe(false);
		expect(field().value).toBe("(555) 123-4567");
	});

	it("leaves navigation keys, shortcuts and unidentified mobile keys to the browser", () => {
		render(<Harness initial="(555) 123-4567" />);
		placeCaret(3);

		for (const init of [
			{ key: "ArrowLeft" },
			{ key: "End" },
			{ key: "Tab" },
			{ key: "Unidentified" },
			{ key: "v", ctrlKey: true },
			{ key: "c", metaKey: true },
		]) {
			expect(fireEvent.keyDown(field(), init)).toBe(true);
		}
		expect(field().value).toBe("(555) 123-4567");
	});

	it("keeps an incomplete number visible and shows the inline error", () => {
		render(<Harness />);
		placeCaret(0);

		type("5550142");
		fireEvent.blur(field());

		// Masked, but nothing invented to complete it.
		expect(field().value).toBe("(555) 014-2");
		const message = screen.getByText(PHONE_MESSAGE);
		expect(field().getAttribute("aria-invalid")).toBe("true");
		expect(field().getAttribute("aria-describedby")).toBe(message.id);
	});

	it("normalises a valid pasted number, with or without the country code", () => {
		render(<Harness />);

		for (const pasted of [
			"5551234567",
			"+1 555 123 4567",
			"+15551234567",
			"15551234567",
			"1-555-123-4567",
			"(555) 123-4567",
			"555.123.4567",
		]) {
			placeCaret(0, field().value.length);
			paste(pasted);

			expect(field().value).toBe("(555) 123-4567");
			expect(caret()).toEqual([14, 14]);
		}
	});

	it("refuses a paste that would overflow, rather than cutting it down", () => {
		render(<Harness />);
		placeCaret(0);

		// Eleven digits with no country code: not cut down into a number nobody entered.
		paste("55512345678");
		expect(field().value).toBe("");

		// A digit fragment with phone punctuation is an ordinary partial paste.
		paste("555-01");
		expect(field().value).toBe("(555) 01");

		// A full field takes no more digits without a selection to replace.
		placeCaret(0, 8);
		paste("5551234567");
		placeCaret(14);
		paste("9");
		expect(field().value).toBe("(555) 123-4567");
	});

	const REFUSED_ENTRIES = [
		"ph: 555-123-4567",
		"call us",
		"555-CALL-NOW",
		"555-123-4567 x12",
		"555-123-4567 ext. 12",
		"555_123_4567",
		"555/123/4567",
		"555#123#4567",
		"+5551234567",
		"+2 555 123 4567",
		"+44 20 7946 0958",
		"++1 555 123 4567",
		"++15551234567",
		"1+555 123 4567",
		"+1 555",
		"",
		"   ",
	];

	it.each(REFUSED_ENTRIES)(
		"refuses the whole paste of %j into an empty field, leaving it unchanged",
		(text) => {
			render(<Harness />);
			placeCaret(0);

			paste(text);

			expect(field().value).toBe("");
		},
	);

	it.each(REFUSED_ENTRIES.filter((text) => text.trim() !== ""))(
		"refuses the whole paste of %j over a selection, leaving the value and selection alone",
		(text) => {
			render(<Harness initial="(555) 123-4567" />);
			placeCaret(6, 9);

			paste(text);

			expect(field().value).toBe("(555) 123-4567");
			expect(caret()).toEqual([6, 9]);
		},
	);

	it("refuses an autofill or mobile change that carries letters or an extension", () => {
		render(<Harness initial="(555) 12" />);
		const input = placeCaret(8);

		for (const raw of [
			"ph: 555-123-4567",
			"(555) 12a",
			"(555) 123-4567 x12",
			"+44 20 7946 0958",
		]) {
			fireEvent.change(input, { target: { value: raw } });
			expect(field().value).toBe("(555) 12");
		}

		// Clearing the field is still an edit a person can make.
		fireEvent.change(input, { target: { value: "" } });
		expect(field().value).toBe("");
	});

	it("pastes over a selection and leaves the caret after the pasted digits", () => {
		render(<Harness initial="(555) 123-4567" />);

		placeCaret(6, 9);
		paste("987");

		expect(field().value).toBe("(555) 987-4567");
		expect(caret()).toEqual([10, 10]);
	});

	it("backspaces over the digit before the caret, stepping across separators", () => {
		render(<Harness initial="(555) 123-4567" />);

		// Caret just after the dash: Backspace removes the 3, not the dash.
		placeCaret(10);
		fireEvent.keyDown(field(), { key: "Backspace" });
		expect(field().value).toBe("(555) 124-567");
		expect(caret()).toEqual([8, 8]);

		placeCaret(13);
		for (const expected of [
			"(555) 124-56",
			"(555) 124-5",
			"(555) 124",
			"(555) 12",
			"(555) 1",
			"(555",
			"(55",
			"(5",
			"",
		]) {
			fireEvent.keyDown(field(), { key: "Backspace" });
			expect(field().value).toBe(expected);
			expect(caret()).toEqual([expected.length, expected.length]);
		}

		expect(fireEvent.keyDown(field(), { key: "Backspace" })).toBe(false);
		expect(field().value).toBe("");
	});

	it("deletes the digit after the caret, stepping across separators", () => {
		render(<Harness initial="(555) 123-4567" />);

		placeCaret(4);
		fireEvent.keyDown(field(), { key: "Delete" });

		expect(field().value).toBe("(555) 234-567");
		expect(caret()).toEqual([6, 6]);

		placeCaret(13);
		fireEvent.keyDown(field(), { key: "Delete" });
		expect(field().value).toBe("(555) 234-567");
	});

	it("replaces a selection with a typed digit, or removes it with Backspace", () => {
		render(<Harness initial="(555) 123-4567" />);

		placeCaret(1, 4);
		type("8");
		expect(field().value).toBe("(812) 345-67");
		expect(caret()).toEqual([2, 2]);

		placeCaret(0, 12);
		fireEvent.keyDown(field(), { key: "Backspace" });
		expect(field().value).toBe("");
	});

	it("inserts a digit mid-number and keeps the caret right after it", () => {
		render(<Harness initial="(555) 123-456" />);

		placeCaret(6);
		type("9");

		expect(field().value).toBe("(555) 912-3456");
		expect(caret()).toEqual([7, 7]);
	});

	it("masks edits from a mobile keyboard or autofill that arrive only as a change", () => {
		render(<Harness initial="(555) 12" />);
		const input = placeCaret(8);

		// A digit inserted mid-value by a keyboard that reports no key.
		fireEvent.change(input, {
			target: { value: "(555) 192", selectionStart: 8, selectionEnd: 8 },
		});
		expect(field().value).toBe("(555) 192");
		expect(caret()).toEqual([8, 8]);

		fireEvent.change(input, { target: { value: "(555) 1923" } });
		expect(field().value).toBe("(555) 192-3");

		// Anything that would take it past ten digits is refused, not truncated.
		fireEvent.change(input, { target: { value: "(555) 192-345678" } });
		expect(field().value).toBe("(555) 192-3");

		// Autofill of a whole number with the country code, into an empty field.
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.change(input, { target: { value: "+1 555 123 4567" } });
		expect(field().value).toBe("(555) 123-4567");
	});

	it("leaves a read-only field untouched", () => {
		render(
			<PhoneInput
				aria-label="Locked phone"
				readOnly
				value="(555) 123-4567"
				onValueChange={() => {
					throw new Error("a read-only field must not change");
				}}
			/>,
		);
		const input = screen.getByLabelText("Locked phone") as HTMLInputElement;
		input.focus();
		input.setSelectionRange(14, 14);

		fireEvent.keyDown(input, { key: "Backspace" });
		fireEvent.keyDown(input, { key: "1" });
		fireEvent.paste(input, { clipboardData: { getData: () => "5551234567" } });

		expect(input.value).toBe("(555) 123-4567");
	});

	it("produces exactly the client validator's canonical spelling for every complete number", () => {
		render(<Harness />);

		for (const pasted of ["2025550123", "+1 (212) 555-0199", "18005551212"]) {
			placeCaret(0, field().value.length);
			paste(pasted);

			expect(field().value).toBe(formatUsPhone(pasted));
		}
	});
});
