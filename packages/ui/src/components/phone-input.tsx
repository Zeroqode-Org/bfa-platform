import { Input } from "@bfa-platform/ui/components/input";
import {
	type DigitMask,
	digitsOf,
	maskedInputHandlers,
} from "@bfa-platform/ui/lib/digit-mask";
import {
	formatUsPhone,
	US_PHONE_CHARACTERS,
} from "@bfa-platform/ui/lib/validation";
import type * as React from "react";

const PHONE_DIGITS = 10;

/**
 * `(XXX) XXX-XXXX`: ten digits, the area code in parentheses, a dash before the
 * last four. Separators follow a completed group only while typing forward, so
 * backspacing through `(555) ` leaves `(555` rather than trapping the caret.
 *
 * Overflow is refused rather than cut: dropping surplus digits could turn an
 * eleven-digit mistake into a valid-looking number nobody entered.
 */
const PHONE_MASK: DigitMask = {
	maxDigits: PHONE_DIGITS,
	overflow: "reject",
	format(digits, trailingSeparator) {
		const kept = digits.slice(0, PHONE_DIGITS);

		if (kept.length === 0) return "";
		if (kept.length < 3 || (kept.length === 3 && !trailingSeparator)) {
			return `(${kept}`;
		}

		const area = `(${kept.slice(0, 3)}) `;

		if (kept.length < 6 || (kept.length === 6 && !trailingSeparator)) {
			return `${area}${kept.slice(3)}`;
		}

		return kept.length === 6
			? `${area}${kept.slice(3)}-`
			: `${area}${kept.slice(3, 6)}-${kept.slice(6)}`;
	},
};

/**
 * The digits a pasted or autofilled entry contributes, or `null` to refuse it.
 *
 * The characters are held to the server's rule (`US_PHONE_CHARACTERS`, the same
 * pattern `normalizeUsPhone` applies): digits and ordinary phone punctuation
 * with at most one leading `+`. Text with anything else — a letter, an
 * extension such as `x12`, a slash — is refused whole. Stripping it instead
 * could turn `ph: 555-123-4567` into a valid number the server would never have
 * accepted as typed.
 *
 * A leading `1` country code in front of ten digits (`+1 555 123 4567`,
 * `15551234567`) is dropped, exactly as the server drops it. A `+` that is not
 * that country code in front of a whole number (`+2 555 123 4567`,
 * `+44 20 7946 0958`, `+1 555`) is refused.
 */
function pastedPhoneDigits(text: string) {
	const trimmed = text.trim();

	if (!US_PHONE_CHARACTERS.test(trimmed)) return null;

	const digits = digitsOf(trimmed);

	if (digits.length === PHONE_DIGITS + 1 && digits.startsWith("1")) {
		return digits.slice(1);
	}

	if (trimmed.startsWith("+") && digits.length !== PHONE_DIGITS) return null;

	return digits;
}

/**
 * A US phone number, masked as `(XXX) XXX-XXXX` while it is typed.
 *
 * Only digits go in, from the keyboard or paste; letters and punctuation are
 * refused, and the text stops at ten digits. Backspace, Delete, selection
 * replacement and paste edit the digits and keep the caret where the person was
 * working. A mobile keyboard or autofill that bypasses the key handlers goes
 * through the same mask in `onChange`.
 *
 * The mask never invents or completes a number: `(555) 014-2` stays as entered
 * and the field's inline validation explains it. The server's normalizer is
 * still the boundary and stores the same canonical spelling.
 */
function PhoneInput({
	value,
	onValueChange,
	onBlur,
	onKeyDown,
	onPaste,
	readOnly,
	...props
}: Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> & {
	value: string;
	onValueChange: (value: string) => void;
}) {
	const mask = maskedInputHandlers({
		mask: PHONE_MASK,
		value,
		readOnly,
		onValueChange,
		onKeyDown,
		onPaste,
		pastedDigits: pastedPhoneDigits,
		changedDigits(raw, previous) {
			const trimmed = raw.trim();

			// Clearing the field is always allowed; any other change containing a
			// character outside the phone rule is refused whole, as for paste.
			if (trimmed === "") return "";
			if (!US_PHONE_CHARACTERS.test(trimmed)) return null;

			// A whole number arriving at once (autofill, a mobile paste) may carry
			// the country code; one digit typed into an existing value may not be
			// reinterpreted as one.
			const digits =
				trimmed.startsWith("+") || digitsOf(previous) === ""
					? pastedPhoneDigits(trimmed)
					: digitsOf(trimmed);

			return digits === null || digits.length > PHONE_DIGITS ? null : digits;
		},
	});

	return (
		<Input
			type="tel"
			inputMode="tel"
			{...props}
			readOnly={readOnly}
			value={value}
			onKeyDown={mask.onKeyDown}
			onPaste={mask.onPaste}
			onChange={mask.onChange}
			onBlur={(event) => {
				// A stored value from before the mask (e.g. `555.123.4567`) that is a
				// valid number takes its canonical spelling when the field is left.
				const formatted = formatUsPhone(event.currentTarget.value);
				if (formatted && formatted !== event.currentTarget.value) {
					onValueChange(formatted);
				}
				onBlur?.(event);
			}}
		/>
	);
}

export { PhoneInput };
