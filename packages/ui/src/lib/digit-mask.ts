import type {
	ChangeEvent,
	ClipboardEvent,
	ClipboardEventHandler,
	KeyboardEvent,
	KeyboardEventHandler,
} from "react";

/**
 * Digit-only input masks — the editing model `DateInput` and `PhoneInput` share.
 *
 * Every edit is modelled on the digits alone, and the separators are re-derived
 * by the mask's `format` after each one, so a separator can never be typed,
 * deleted or duplicated on its own. A caret position is carried across an edit
 * as "after the Nth digit", which keeps it where the person was working however
 * many separators appear or disappear around it.
 *
 * A mask shapes text only. It never checks or repairs what the digits mean —
 * that is the field's inline validation — and it never invents a digit.
 */

export type MaskedValue = { value: string; caret: number };

export type DigitEdit =
	| { kind: "insert"; digits: string }
	| { kind: "backspace" }
	| { kind: "delete" };

export type DigitMask = {
	maxDigits: number;
	/**
	 * Digits as display text. `trailingSeparator` asks for the separator after a
	 * just-completed group, which is what typing forward should show.
	 */
	format: (digits: string, trailingSeparator: boolean) => string;
	/**
	 * What an insertion that does not fit does: `truncate` keeps the digits that
	 * fit, `reject` changes nothing. A single keystroke into a full field is
	 * refused either way.
	 */
	overflow: "truncate" | "reject";
};

export function digitsOf(text: string) {
	return text.replace(/\D/g, "");
}

export function digitCountBefore(text: string, position: number) {
	return digitsOf(text.slice(0, position)).length;
}

/** The caret just after the Nth digit, stepping over the separators that follow it. */
export function caretAfterDigits(text: string, count: number) {
	if (count <= 0) return 0;

	let seen = 0;

	for (let index = 0; index < text.length; index += 1) {
		if (!/\d/.test(text.charAt(index))) continue;

		seen += 1;

		if (seen === count) {
			let caret = index + 1;
			while (caret < text.length && !/\d/.test(text.charAt(caret))) caret += 1;

			return caret;
		}
	}

	return text.length;
}

/**
 * One edit applied to the current text and selection, or `null` when it changes
 * nothing (Backspace at the start, a digit into a full field, an overflowing
 * insertion under `reject`).
 *
 * A selection is removed first, then an insertion takes its place. Backspace
 * and Delete without a selection remove the digit on their side of the caret,
 * skipping any separator between.
 */
export function applyDigitEdit(
	mask: DigitMask,
	text: string,
	selectionStart: number,
	selectionEnd: number,
	edit: DigitEdit,
): MaskedValue | null {
	const digits = digitsOf(text);
	let removeFrom = digitCountBefore(text, selectionStart);
	let removeTo = digitCountBefore(text, selectionEnd);

	if (edit.kind !== "insert" && removeFrom === removeTo) {
		if (edit.kind === "backspace") {
			if (removeFrom === 0) return null;
			removeFrom -= 1;
		} else {
			if (removeFrom >= digits.length) return null;
			removeTo += 1;
		}
	}

	const kept = digits.slice(0, removeFrom) + digits.slice(removeTo);
	const room = mask.maxDigits - kept.length;
	let inserted = "";

	if (edit.kind === "insert") {
		if (edit.digits.length === 0) return null;
		if (edit.digits.length > room && mask.overflow === "reject") return null;

		inserted = edit.digits.slice(0, room);

		if (inserted.length === 0) return null;
	}

	const next = kept.slice(0, removeFrom) + inserted + kept.slice(removeFrom);
	const caretDigits = removeFrom + inserted.length;
	const value = mask.format(
		next,
		inserted.length > 0 && caretDigits === next.length,
	);

	return { value, caret: caretAfterDigits(value, caretDigits) };
}

/**
 * The keyboard, paste and change handlers for a masked text input.
 *
 * Keystrokes and paste are handled directly and cancelled, so the browser never
 * inserts a character the mask did not decide on. Anything that bypasses them —
 * a mobile keyboard reporting `Unidentified`, an IME, autofill, a programmatic
 * change — arrives in `onChange` and goes through `changedDigits`.
 *
 * Each edit writes the masked text and caret to the element before telling the
 * owner, so when React re-renders with the new value the DOM already holds it
 * and the caret stays where it was put.
 */
export function maskedInputHandlers({
	mask,
	value,
	readOnly,
	onValueChange,
	onKeyDown,
	onPaste,
	pastedDigits,
	changedDigits,
}: {
	mask: DigitMask;
	value: string;
	readOnly?: boolean;
	onValueChange: (value: string) => void;
	onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
	onPaste?: ClipboardEventHandler<HTMLInputElement>;
	/** The digits a pasted text contributes, or `null` to refuse the paste outright. */
	pastedDigits: (text: string) => string | null;
	/**
	 * The digits an edit only `onChange` saw should leave, or `null` to refuse it
	 * and keep the current value.
	 */
	changedDigits: (raw: string, previous: string) => string | null;
}) {
	function commit(input: HTMLInputElement, next: MaskedValue) {
		if (input.value !== next.value) input.value = next.value;
		if (input.ownerDocument.activeElement === input) {
			input.setSelectionRange(next.caret, next.caret);
		}
		if (next.value !== value) onValueChange(next.value);
	}

	function selection(input: HTMLInputElement) {
		const start = input.selectionStart ?? input.value.length;

		return [start, input.selectionEnd ?? start] as const;
	}

	return {
		onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
			onKeyDown?.(event);

			if (
				event.defaultPrevented ||
				readOnly ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				event.nativeEvent.isComposing
			) {
				return;
			}

			let edit: DigitEdit;

			if (/^\d$/.test(event.key)) {
				edit = { kind: "insert", digits: event.key };
			} else if (event.key === "Backspace") {
				edit = { kind: "backspace" };
			} else if (event.key === "Delete") {
				edit = { kind: "delete" };
			} else {
				// A printable key that is not a digit — a letter, punctuation, a space
				// — is refused. Navigation, shortcut and `Unidentified` keys pass.
				if (event.key.length === 1) event.preventDefault();
				return;
			}

			event.preventDefault();

			const input = event.currentTarget;
			const [start, end] = selection(input);
			const next = applyDigitEdit(mask, input.value, start, end, edit);

			if (next) commit(input, next);
		},

		onPaste(event: ClipboardEvent<HTMLInputElement>) {
			onPaste?.(event);

			if (event.defaultPrevented || readOnly) return;

			event.preventDefault();

			// A refused paste changes nothing — not even the selection it would
			// have replaced.
			const digits = pastedDigits(event.clipboardData.getData("text"));

			if (digits === null) return;

			const input = event.currentTarget;
			const [start, end] = selection(input);
			const next = applyDigitEdit(mask, input.value, start, end, {
				kind: "insert",
				digits,
			});

			if (next) commit(input, next);
		},

		onChange(event: ChangeEvent<HTMLInputElement>) {
			const input = event.currentTarget;
			const raw = input.value;
			const caret = input.selectionStart ?? raw.length;
			const digits = changedDigits(raw, value);

			if (digits === null) {
				commit(input, { value, caret: value.length });
				return;
			}

			const masked = mask.format(digits.slice(0, mask.maxDigits), false);

			commit(input, {
				value: masked,
				caret:
					caret >= raw.length
						? masked.length
						: caretAfterDigits(
								masked,
								Math.min(digitCountBefore(raw, caret), digits.length),
							),
			});
		},
	};
}
