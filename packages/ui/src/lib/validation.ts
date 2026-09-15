/**
 * Client-side field rules and the value formats they understand.
 *
 * Pure on purpose — no React, no Zod — so a form, a filter and a test can all
 * ask the same question and get the same answer. None of this is a boundary:
 * every rule here exists to tell a person about a problem before a request is
 * made, and the procedure or server action behind the form checks it again.
 *
 * A rule is `(value) => message | undefined`. Rules that check a *shape*
 * (email, phone, date, length) pass a blank value, so "optional" is simply the
 * absence of `required` in front of them rather than a flag on each one.
 */

export type FieldRule = (value: string) => string | undefined;

export const EMAIL_MESSAGE = "Please enter a valid email address.";
export const PHONE_MESSAGE = "Please enter a valid 10-digit US phone number.";
export const US_DATE_FORMAT = "MM/DD/YYYY";
export const DATE_MESSAGE = `Please enter a valid date in ${US_DATE_FORMAT} format.`;

export function maxLengthMessage(max: number) {
	return `Must be ${max.toLocaleString("en-US")} characters or fewer.`;
}

/**
 * A reasonable address shape: something, one `@`, and a dotted domain with no
 * empty labels. Deliberately looser than the server's `z.email()` — a value
 * that passes here and is still refused there comes back as the server's own
 * message, which is the honest outcome, whereas a client stricter than the
 * server would block an address the server would have stored.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isEmailAddress(value: string) {
	return EMAIL_PATTERN.test(value.trim());
}

/**
 * Whether `value` is a real `YYYY-MM-DD` calendar day, not merely the shape.
 *
 * The round trip through `Date` is what catches `2026-02-30`: it parses, rolls
 * forward into March, and spells itself differently on the way back.
 */
export function isIsoCalendarDate(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

	const parsed = new Date(`${value}T00:00:00Z`);

	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

/**
 * `MM/DD/YYYY` as people type it: one- or two-digit month and day, and all four
 * digits of the year. A two-digit year is refused rather than guessed at — `27`
 * could be 1927 or 2027, and a wrong guess is a reminder in the wrong century.
 */
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** A typed `MM/DD/YYYY` date as the API's `YYYY-MM-DD`, or `null` if it is not a real day. */
export function usDateToIso(value: string): string | null {
	const match = US_DATE_PATTERN.exec(value.trim());
	if (!match) return null;

	const [, month = "", day = "", year = ""] = match;
	const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

	return isIsoCalendarDate(iso) ? iso : null;
}

/** A stored `YYYY-MM-DD` date as `MM/DD/YYYY`, or `""` for no date. */
export function isoToUsDate(value: string | null | undefined): string {
	if (!value || !isIsoCalendarDate(value)) return "";

	const [year = "", month = "", day = ""] = value.split("-");

	return `${month}/${day}/${year}`;
}

/** A valid typed date in its exact spelling (`2/3/2027` → `02/03/2027`), or `null`. */
export function normalizeUsDate(value: string): string | null {
	const iso = usDateToIso(value);

	return iso ? isoToUsDate(iso) : null;
}

/**
 * The characters a phone entry may contain at all: digits, spaces, dots,
 * dashes, parentheses, and at most one leading `+`. The same rule as the
 * server's `normalizeUsPhone`; anything else — a letter, an extension, a
 * slash — makes the whole entry invalid rather than being stripped.
 */
export const US_PHONE_CHARACTERS = /^\+?[\d\s().-]+$/;

/**
 * The ten digits of a US phone number, or `null`.
 *
 * Accepts the punctuation people actually type — spaces, dots, dashes,
 * parentheses and a leading `+1`/`1` — and nothing else, so a letter or an
 * extension is refused rather than stripped. A `+` is only ever part of the
 * `+1` country code, so `+5551234567` is refused, the same as the server's
 * `normalizeUsPhone` refuses it. Never truncates: eleven digits that do not
 * start with the country code are simply not a number.
 */
export function usPhoneDigits(value: string): string | null {
	const trimmed = value.trim();
	if (!US_PHONE_CHARACTERS.test(trimmed)) return null;

	const digits = trimmed.replace(/\D/g, "");
	const hasCountryCode = digits.length === 11 && digits.startsWith("1");

	// A leading `+` must introduce the US country code in front of ten digits.
	if (trimmed.startsWith("+") && !hasCountryCode) return null;

	const national = hasCountryCode ? digits.slice(1) : digits;

	return national.length === 10 ? national : null;
}

/** A valid phone number as `(XXX) XXX-XXXX`, or `null` — an invalid one is never altered. */
export function formatUsPhone(value: string): string | null {
	const digits = usPhoneDigits(value);

	return digits
		? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
		: null;
}

/** Fails on a blank or whitespace-only value, the way the server's `.trim().min(1)` does. */
export function required(message: string): FieldRule {
	return (value) => (value.trim() ? undefined : message);
}

/**
 * Fails past `max` characters. Measured on the trimmed value by default,
 * because that is what the server's `.trim().max()` measures; pass
 * `trim: false` for a value the server stores as typed, such as a password.
 */
export function maxLength(
	max: number,
	{ trim = true }: { trim?: boolean } = {},
): FieldRule {
	return (value) =>
		(trim ? value.trim() : value).length > max
			? maxLengthMessage(max)
			: undefined;
}

export function minLength(min: number, message: string): FieldRule {
	return (value) => (value && value.length < min ? message : undefined);
}

export function email(message = EMAIL_MESSAGE): FieldRule {
	return (value) =>
		!value.trim() || isEmailAddress(value) ? undefined : message;
}

export function usPhone(message = PHONE_MESSAGE): FieldRule {
	return (value) =>
		!value.trim() || usPhoneDigits(value) ? undefined : message;
}

export function usDate(message = DATE_MESSAGE): FieldRule {
	return (value) => (!value.trim() || usDateToIso(value) ? undefined : message);
}

export const DATE_ORDER_MESSAGE = "Must be on or after the start date.";

/**
 * The end of a date range may not come before its start. Silent while either
 * end is blank or not yet a real date — those are the date rule's to report.
 */
export function usDateNotBefore(
	start: string,
	message = DATE_ORDER_MESSAGE,
): FieldRule {
	return (value) => {
		const startIso = usDateToIso(start);
		const endIso = usDateToIso(value);

		return startIso && endIso && endIso < startIso ? message : undefined;
	};
}

/** Runs rules in order and reports the first failure, so a field shows one message at a time. */
export function composeRules(...rules: FieldRule[]): FieldRule {
	return (value) => {
		for (const rule of rules) {
			const message = rule(value);
			if (message) return message;
		}

		return undefined;
	};
}
