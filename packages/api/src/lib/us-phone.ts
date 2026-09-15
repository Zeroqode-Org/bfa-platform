/**
 * US phone numbers, as the repair-company contract accepts and stores them.
 *
 * One canonical representation: `(XXX) XXX-XXXX`. Whatever punctuation a caller
 * sends, a valid number is stored in that spelling, so the column never holds
 * two spellings of one number and a failure notice always quotes the same form.
 *
 * Accepts ten digits with ordinary punctuation — spaces, dots, dashes,
 * parentheses — and an optional leading `+1` or `1`. A `+` is only ever part of
 * that `+1` country code: `+5551234567` is ten digits, but it claims a country
 * code it does not have, so it is refused rather than read as a US number.
 * Refuses everything else rather than stripping it: a letter, an extension, a
 * second `+`, or any digit count other than ten (or eleven starting with the
 * country code). Nothing is ever truncated to make a value fit.
 *
 * Pure and import-free, so the input schema can use it without a database and
 * the web app can check it against the form's own rule
 * (`formatUsPhone` in `@bfa-platform/ui/lib/validation`) in a parity test.
 */

export const US_PHONE_MESSAGE = "Enter a valid 10-digit US phone number";

/** Digits and the punctuation people type, with at most one leading `+`. */
const PHONE_CHARACTERS = /^\+?[\d\s().-]+$/;

/** A valid number as `(XXX) XXX-XXXX`, or `null` when the value is not one. */
export function normalizeUsPhone(value: string): string | null {
	const trimmed = value.trim();
	if (!PHONE_CHARACTERS.test(trimmed)) return null;

	const digits = trimmed.replace(/\D/g, "");
	const hasCountryCode = digits.length === 11 && digits.startsWith("1");

	// A leading `+` must introduce the US country code in front of ten digits.
	if (trimmed.startsWith("+") && !hasCountryCode) return null;

	const national = hasCountryCode ? digits.slice(1) : digits;

	if (national.length !== 10) return null;

	return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}
