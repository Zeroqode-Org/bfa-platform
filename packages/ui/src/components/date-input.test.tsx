// @vitest-environment jsdom

import { DateInput } from "@bfa-platform/ui/components/date-input";
import { FieldError } from "@bfa-platform/ui/components/field-message";
import { Label } from "@bfa-platform/ui/components/label";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	DATE_MESSAGE,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The shared date field: typed `MM/DD/YYYY` entry, the calendar picker beside
 * it, and both wired to the shared inline validation the way a form uses them.
 */

const PICKER = "Choose annual test date";

function Harness({
	initial = "",
	disabled = false,
	onChange,
}: {
	initial?: string;
	disabled?: boolean;
	onChange?: (value: string) => void;
}) {
	const [value, setValue] = useState(initial);
	const validation = useFormValidation({
		values: { date: value },
		rules: { date: usDate() },
	});

	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				validation.validate();
			}}
		>
			<Label htmlFor={validation.fieldId("date")}>Annual test date</Label>
			<DateInput
				{...validation.controlProps("date")}
				pickerLabel={PICKER}
				disabled={disabled}
				value={value}
				onValueChange={(next) => {
					setValue(next);
					onChange?.(next);
				}}
			/>
			<FieldError {...validation.errorProps("date")} />
			<button type="submit">Save</button>
		</form>
	);
}

function field() {
	return screen.getByLabelText("Annual test date") as HTMLInputElement;
}

function trigger() {
	return screen.getByRole("button", { name: PICKER });
}

async function openPicker() {
	fireEvent.click(trigger());

	return within(await screen.findByRole("dialog", { name: PICKER }));
}

/** The day button focus is on, by its announced name. */
async function focusedDay(name: string) {
	await waitFor(() =>
		expect(document.activeElement?.getAttribute("aria-label")).toBe(name),
	);

	return document.activeElement as HTMLButtonElement;
}

function press(key: string, init: { shiftKey?: boolean } = {}) {
	fireEvent.keyDown(document.activeElement as Element, { key, ...init });
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("DateInput — typed entry", () => {
	it("is a text field with a calendar button, never a native date input", () => {
		render(<Harness />);

		const input = field();
		const form = input.closest("form") as HTMLFormElement;

		expect(input.type).toBe("text");
		expect(input.placeholder).toBe("MM/DD/YYYY");
		expect(form.querySelectorAll('input[type="date"]')).toHaveLength(0);
		expect(form.querySelectorAll("[required], [pattern]")).toHaveLength(0);
		expect(trigger()).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("normalises a valid typed date to exactly MM/DD/YYYY on blur", () => {
		render(<Harness />);

		fireEvent.change(field(), { target: { value: "2/3/2027" } });
		fireEvent.blur(field());

		expect(field().value).toBe("02/03/2027");
		expect(screen.queryByText(DATE_MESSAGE)).toBeNull();
	});

	it("keeps an impossible calendar date visible and explains it inline", () => {
		render(<Harness />);

		fireEvent.change(field(), { target: { value: "02/30/2026" } });
		fireEvent.blur(field());

		expect(field().value).toBe("02/30/2026");
		const message = screen.getByText(DATE_MESSAGE);
		expect(field().getAttribute("aria-invalid")).toBe("true");
		expect(field().getAttribute("aria-describedby")).toBe(message.id);

		// Persistent: submitting does not clear or rewrite it.
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(field().value).toBe("02/30/2026");
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();
	});

	it("masks a two-digit year or short entry but never completes it into a valid date", () => {
		render(<Harness />);

		for (const [entered, masked] of [
			["2/3/27", "02/03/27"],
			["02/03/027", "02/03/027"],
			["23123", "23/12/3"],
		] as const) {
			fireEvent.change(field(), { target: { value: entered } });
			fireEvent.blur(field());

			expect(field().value).toBe(masked);
			expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();
		}
	});
});

describe("DateInput — MM/DD/YYYY mask", () => {
	/** Focuses the field with the caret (or selection) where a person would put it. */
	function placeCaret(start: number, end = start) {
		const input = field();
		input.focus();
		input.setSelectionRange(start, end);

		return input;
	}

	/** Types each character as a keystroke, the way a keyboard delivers it. */
	function type(text: string) {
		for (const key of text) fireEvent.keyDown(field(), { key });
	}

	function caret() {
		return [field().selectionStart, field().selectionEnd];
	}

	it("inserts the slashes after the month and the day while digits are typed", () => {
		render(<Harness />);
		placeCaret(0);

		const steps: [string, string][] = [
			["0", "0"],
			["2", "02/"],
			["0", "02/0"],
			["3", "02/03/"],
			["2", "02/03/2"],
			["0", "02/03/20"],
			["2", "02/03/202"],
			["7", "02/03/2027"],
		];

		for (const [key, expected] of steps) {
			type(key);
			expect(field().value).toBe(expected);
			expect(caret()).toEqual([expected.length, expected.length]);
		}
	});

	it("masks arbitrary digits such as 23123123, and leaves the impossible date for validation", () => {
		render(<Harness />);
		placeCaret(0);

		type("23123123");

		expect(field().value).toBe("23/12/3123");
		fireEvent.blur(field());
		expect(field().value).toBe("23/12/3123");
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();
	});

	it("refuses letters, punctuation and spaces from the keyboard, and stops at eight digits", () => {
		render(<Harness initial="02/03/202" />);
		placeCaret(9);

		for (const key of ["a", "Z", "/", "-", ".", " "]) {
			// `false` means the keystroke was cancelled rather than merely ignored.
			expect(fireEvent.keyDown(field(), { key })).toBe(false);
			expect(field().value).toBe("02/03/202");
		}

		type("7");
		expect(field().value).toBe("02/03/2027");

		expect(fireEvent.keyDown(field(), { key: "1" })).toBe(false);
		expect(field().value).toBe("02/03/2027");
		expect(field().value).toHaveLength(10);
	});

	it("leaves navigation keys and shortcuts to the browser", () => {
		render(<Harness initial="02/03/2027" />);
		placeCaret(3);

		for (const init of [
			{ key: "ArrowLeft" },
			{ key: "ArrowRight" },
			{ key: "Home" },
			{ key: "End" },
			{ key: "Tab" },
			{ key: "a", ctrlKey: true },
			{ key: "v", ctrlKey: true },
			{ key: "c", metaKey: true },
		]) {
			expect(fireEvent.keyDown(field(), init)).toBe(true);
		}
		expect(field().value).toBe("02/03/2027");
	});

	it("pastes digits into place, pads a whole pasted date, and ignores text with no digits", () => {
		render(<Harness />);
		placeCaret(0);

		fireEvent.paste(field(), { clipboardData: { getData: () => "abc" } });
		expect(field().value).toBe("");

		fireEvent.paste(field(), { clipboardData: { getData: () => "2/3/2027" } });
		expect(field().value).toBe("02/03/2027");
		expect(caret()).toEqual([10, 10]);

		// Replacing the day with a pasted selection keeps the caret after it.
		placeCaret(3, 5);
		fireEvent.paste(field(), { clipboardData: { getData: () => "15" } });
		expect(field().value).toBe("02/15/2027");
		expect(caret()).toEqual([6, 6]);

		// Surplus digits are cut at eight rather than overflowing the format.
		placeCaret(0, 10);
		fireEvent.paste(field(), {
			clipboardData: { getData: () => "0415202699" },
		});
		expect(field().value).toBe("04/15/2026");
	});

	it("pastes an impossible calendar date as entered, for the inline error to explain", () => {
		render(<Harness />);
		placeCaret(0);

		fireEvent.paste(field(), {
			clipboardData: { getData: () => "02/30/2026" },
		});
		fireEvent.blur(field());

		expect(field().value).toBe("02/30/2026");
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();
		expect(field().getAttribute("aria-invalid")).toBe("true");
	});

	it("backspaces over the digit before the caret, stepping across a slash", () => {
		render(<Harness initial="02/03/2027" />);

		// Caret just after the second slash: Backspace removes the 3, not the slash.
		placeCaret(6);
		fireEvent.keyDown(field(), { key: "Backspace" });
		expect(field().value).toBe("02/02/027");
		expect(caret()).toEqual([4, 4]);

		// Backspacing from the end removes digits one at a time, slashes following.
		placeCaret(9);
		for (const expected of [
			"02/02/02",
			"02/02/0",
			"02/02",
			"02/0",
			"02",
			"0",
			"",
		]) {
			fireEvent.keyDown(field(), { key: "Backspace" });
			expect(field().value).toBe(expected);
		}

		// Nothing to remove at the start.
		expect(fireEvent.keyDown(field(), { key: "Backspace" })).toBe(false);
		expect(field().value).toBe("");
	});

	it("deletes the digit after the caret, stepping across a slash", () => {
		render(<Harness initial="02/03/2027" />);

		placeCaret(2);
		fireEvent.keyDown(field(), { key: "Delete" });

		expect(field().value).toBe("02/32/027");
		expect(caret()).toEqual([3, 3]);

		placeCaret(9);
		fireEvent.keyDown(field(), { key: "Delete" });
		expect(field().value).toBe("02/32/027");
	});

	it("replaces a selection with a typed digit, or removes it with Backspace", () => {
		render(<Harness initial="02/03/2027" />);

		placeCaret(3, 5);
		fireEvent.keyDown(field(), { key: "Backspace" });
		expect(field().value).toBe("02/20/27");
		expect(caret()).toEqual([3, 3]);

		placeCaret(0, 8);
		type("1");
		expect(field().value).toBe("1");
		expect(caret()).toEqual([1, 1]);
	});

	it("inserts a digit mid-value and keeps the caret right after it", () => {
		render(<Harness initial="02/03/202" />);

		placeCaret(3);
		type("1");

		expect(field().value).toBe("02/10/3202");
		expect(caret()).toEqual([4, 4]);
	});

	it("masks a typed impossible calendar date without repairing it", () => {
		render(<Harness />);
		placeCaret(0);

		type("02302026");
		fireEvent.blur(field());

		expect(field().value).toBe("02/30/2026");
		const message = screen.getByText(DATE_MESSAGE);
		expect(field().getAttribute("aria-describedby")).toBe(message.id);
		expect(usDateToIso(field().value)).toBeNull();
	});

	it("does not edit a read-only field", () => {
		function ReadOnly() {
			return (
				<DateInput
					aria-label="Locked date"
					readOnly
					value="02/03/2027"
					onValueChange={() => {
						throw new Error("a read-only field must not change");
					}}
				/>
			);
		}

		render(<ReadOnly />);
		const input = screen.getByLabelText("Locked date") as HTMLInputElement;
		input.focus();
		input.setSelectionRange(10, 10);

		fireEvent.keyDown(input, { key: "Backspace" });
		fireEvent.keyDown(input, { key: "1" });

		expect(input.value).toBe("02/03/2027");
	});
});

describe("DateInput — calendar picker", () => {
	it("opens a labelled dialog on the typed date, with that day selected and focused", async () => {
		render(<Harness initial="02/03/2027" />);

		const dialog = await openPicker();

		expect(dialog.getByText("February 2027")).toBeTruthy();
		expect(dialog.getByRole("grid", { name: "February 2027" })).toBeTruthy();
		expect(dialog.getAllByRole("columnheader")).toHaveLength(7);

		const day = await focusedDay("Wednesday, February 3, 2027");
		expect(day.tabIndex).toBe(0);

		const selected = dialog
			.getAllByRole("gridcell")
			.filter((cell) => cell.getAttribute("aria-selected") === "true");
		expect(selected).toHaveLength(1);
		expect(selected[0]?.contains(day)).toBe(true);
		// The grid semantics live on the cell; the day inside it stays a real
		// button, so assistive technology still announces and activates a button.
		expect(day.tagName).toBe("BUTTON");
		expect(day.getAttribute("type")).toBe("button");
		expect(day.hasAttribute("role")).toBe(false);
		expect(selected[0]?.tagName).toBe("TD");
		expect(
			dialog.getByRole("button", { name: "Wednesday, February 3, 2027" }),
		).toBe(day);
		expect(
			dialog
				.getAllByRole("gridcell")
				.every((cell) => cell.querySelector("button:not([role])")),
		).toBe(true);

		// One tab stop in the grid: every other day is reachable by arrow keys only.
		expect(
			dialog
				.getAllByRole("gridcell")
				.map((cell) => cell.querySelector("button")?.tabIndex)
				.filter((index) => index === 0),
		).toHaveLength(1);
	});

	it("writes the chosen day into the field as exactly MM/DD/YYYY", async () => {
		const onChange = vi.fn();
		render(<Harness initial="02/03/2027" onChange={onChange} />);

		const dialog = await openPicker();
		fireEvent.click(
			dialog.getByRole("button", { name: "Tuesday, February 9, 2027" }),
		);

		expect(field().value).toBe("02/09/2027");
		expect(onChange).toHaveBeenLastCalledWith("02/09/2027");
		// And the value converts to the API's calendar day with no zone shift.
		expect(usDateToIso(field().value)).toBe("2027-02-09");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger()));
	});

	it("moves through days, weeks, weeks' ends, months and years from the keyboard", async () => {
		render(<Harness initial="02/03/2027" />);

		const dialog = await openPicker();
		await focusedDay("Wednesday, February 3, 2027");

		press("ArrowRight");
		await focusedDay("Thursday, February 4, 2027");
		press("ArrowDown");
		await focusedDay("Thursday, February 11, 2027");
		press("ArrowLeft");
		await focusedDay("Wednesday, February 10, 2027");
		press("ArrowUp");
		await focusedDay("Wednesday, February 3, 2027");
		press("End");
		await focusedDay("Saturday, February 6, 2027");
		press("Home");
		await focusedDay("Sunday, January 31, 2027");
		// Crossing into another month re-renders the grid and announces it.
		expect(dialog.getByText("January 2027").getAttribute("aria-live")).toBe(
			"polite",
		);

		press("PageDown");
		// 31 January plus a month is clamped to the last day of February.
		await focusedDay("Sunday, February 28, 2027");
		press("PageDown", { shiftKey: true });
		await focusedDay("Monday, February 28, 2028");
		press("ArrowRight");
		await focusedDay("Tuesday, February 29, 2028");
		press("PageUp");
		await focusedDay("Saturday, January 29, 2028");

		// Enter and Space activate the focused day button natively; jsdom does not
		// synthesise that activation, so the click stands in for it.
		fireEvent.click(document.activeElement as Element);

		expect(field().value).toBe("01/29/2028");
		await waitFor(() => expect(document.activeElement).toBe(trigger()));
	});

	it("closes on Escape without changing the value, returning focus to the button", async () => {
		render(<Harness initial="02/03/2027" />);

		await openPicker();
		await focusedDay("Wednesday, February 3, 2027");
		press("ArrowRight");
		await focusedDay("Thursday, February 4, 2027");

		press("Escape");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(field().value).toBe("02/03/2027");
		await waitFor(() => expect(document.activeElement).toBe(trigger()));
	});

	it("opens on today when the field is empty or invalid, marks today, and pages by month with named buttons", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 8, 14, 12));
		render(<Harness />);

		fireEvent.change(field(), { target: { value: "02/30/2026" } });
		fireEvent.blur(field());
		expect(screen.getByText(DATE_MESSAGE)).toBeTruthy();

		const dialog = await openPicker();
		const today = await focusedDay("Monday, September 14, 2026");
		expect(today.getAttribute("aria-current")).toBe("date");

		fireEvent.click(dialog.getByRole("button", { name: "Next month" }));
		expect(dialog.getByText("October 2026")).toBeTruthy();
		fireEvent.click(dialog.getByRole("button", { name: "Previous month" }));
		fireEvent.click(dialog.getByRole("button", { name: "Previous month" }));
		expect(dialog.getByText("August 2026")).toBeTruthy();

		fireEvent.click(
			dialog.getByRole("button", { name: "Monday, August 31, 2026" }),
		);

		// Choosing a real day replaces the invalid text and clears its error.
		expect(field().value).toBe("08/31/2026");
		expect(screen.queryByText(DATE_MESSAGE)).toBeNull();
		expect(field().getAttribute("aria-invalid")).toBeNull();
	});

	it("disables the calendar button with the field", () => {
		render(<Harness disabled />);

		const button = trigger() as HTMLButtonElement;
		expect(
			button.disabled || button.getAttribute("aria-disabled") === "true",
		).toBe(true);
	});
});
