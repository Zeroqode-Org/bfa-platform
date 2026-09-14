import { describe, expect, it } from "vitest";

import {
	composeRules,
	DATE_MESSAGE,
	DATE_ORDER_MESSAGE,
	EMAIL_MESSAGE,
	email,
	formatUsPhone,
	isEmailAddress,
	isIsoCalendarDate,
	isoToUsDate,
	maxLength,
	maxLengthMessage,
	normalizeUsDate,
	PHONE_MESSAGE,
	required,
	usDate,
	usDateNotBefore,
	usDateToIso,
	usPhone,
	usPhoneDigits,
} from "./validation";

describe("isEmailAddress", () => {
	it("accepts ordinary addresses, including a stray space the server trims", () => {
		expect(isEmailAddress("tester@example.com")).toBe(true);
		expect(isEmailAddress("first.last+tag@mail.example.co.uk")).toBe(true);
		expect(isEmailAddress("  tester@example.com ")).toBe(true);
	});

	it("refuses what is not an address", () => {
		for (const value of [
			"",
			"tester",
			"tester@",
			"@example.com",
			"tester@example",
			"tester@example..com",
			"two words@example.com",
			"a@b@example.com",
		]) {
			expect(isEmailAddress(value)).toBe(false);
		}
	});
});

describe("US dates", () => {
	it("converts a typed MM/DD/YYYY date to the API's ISO day", () => {
		expect(usDateToIso("04/01/2027")).toBe("2027-04-01");
		expect(usDateToIso("4/1/2027")).toBe("2027-04-01");
		expect(usDateToIso(" 12/31/2026 ")).toBe("2026-12-31");
		expect(usDateToIso("02/29/2028")).toBe("2028-02-29");
		expect(usDateToIso("12/31/1999")).toBe("1999-12-31");
	});

	it("refuses impossible calendar dates rather than rolling them forward", () => {
		expect(usDateToIso("02/30/2026")).toBeNull();
		expect(usDateToIso("02/29/2027")).toBeNull();
		expect(usDateToIso("13/01/2026")).toBeNull();
		expect(usDateToIso("00/10/2026")).toBeNull();
		expect(usDateToIso("04/31/2026")).toBeNull();
	});

	it("refuses a two-digit year instead of guessing its century", () => {
		expect(usDateToIso("04/01/27")).toBeNull();
		expect(usDateToIso("2/3/27")).toBeNull();
		expect(usDateToIso("04/01/027")).toBeNull();
		expect(usDateToIso("04/01/20271")).toBeNull();
	});

	it("refuses other delimiters and shapes", () => {
		expect(usDateToIso("04-01-2027")).toBeNull();
		expect(usDateToIso("2027-04-01")).toBeNull();
		expect(usDateToIso("04012027")).toBeNull();
		expect(usDateToIso("004/01/2027")).toBeNull();
		expect(usDateToIso("next April")).toBeNull();
	});

	it("round-trips a stored date through the display format", () => {
		expect(isoToUsDate("2027-04-01")).toBe("04/01/2027");
		expect(usDateToIso(isoToUsDate("2027-04-01"))).toBe("2027-04-01");
		expect(isoToUsDate("1999-12-31")).toBe("12/31/1999");
		expect(isoToUsDate(null)).toBe("");
		expect(isoToUsDate("")).toBe("");
	});

	it("normalises a valid date to the exact MM/DD/YYYY spelling and leaves an invalid one alone", () => {
		expect(normalizeUsDate("2/3/2027")).toBe("02/03/2027");
		expect(normalizeUsDate(" 02/03/2027 ")).toBe("02/03/2027");
		expect(normalizeUsDate("02/30/2026")).toBeNull();
		expect(normalizeUsDate("2/3/27")).toBeNull();
	});

	it("checks ISO calendar days", () => {
		expect(isIsoCalendarDate("2026-02-28")).toBe(true);
		expect(isIsoCalendarDate("2026-02-30")).toBe(false);
		expect(isIsoCalendarDate("2026-2-3")).toBe(false);
	});
});

describe("US phone numbers", () => {
	it("accepts ten digits however they are punctuated", () => {
		for (const value of [
			"5551234567",
			"555-123-4567",
			"(555) 123-4567",
			"555.123.4567",
			"+1 555 123 4567",
			"1-555-123-4567",
		]) {
			expect(usPhoneDigits(value)).toBe("5551234567");
		}
	});

	it("formats a valid number as (XXX) XXX-XXXX", () => {
		expect(formatUsPhone("555.123.4567")).toBe("(555) 123-4567");
	});

	it("refuses rather than truncating or stripping", () => {
		expect(usPhoneDigits("555-0142")).toBeNull();
		expect(usPhoneDigits("55512345678")).toBeNull();
		expect(usPhoneDigits("555-123-4567 x12")).toBeNull();
		expect(usPhoneDigits("555-CALL-NOW")).toBeNull();
		expect(formatUsPhone("555-0142")).toBeNull();
	});
});

describe("rules", () => {
	it("required fails only on blank or whitespace", () => {
		const rule = required("Name is required.");

		expect(rule("")).toBe("Name is required.");
		expect(rule("   ")).toBe("Name is required.");
		expect(rule("Marta")).toBeUndefined();
	});

	it("shape rules pass a blank value, so optional is the absence of required", () => {
		expect(email()("")).toBeUndefined();
		expect(usPhone()("")).toBeUndefined();
		expect(usDate()("")).toBeUndefined();

		expect(email()("tester@")).toBe(EMAIL_MESSAGE);
		expect(usPhone()("555-0142")).toBe(PHONE_MESSAGE);
		expect(usDate()("02/30/2026")).toBe(DATE_MESSAGE);
		expect(usDate()("02/03/27")).toBe(DATE_MESSAGE);
		expect(DATE_MESSAGE).toBe(
			"Please enter a valid date in MM/DD/YYYY format.",
		);
	});

	it("maxLength measures the trimmed value unless told otherwise", () => {
		expect(maxLength(3)(" abc ")).toBeUndefined();
		expect(maxLength(3)("abcd")).toBe(maxLengthMessage(3));
		expect(maxLength(3, { trim: false })(" abc")).toBe(maxLengthMessage(3));
	});

	it("usDateNotBefore refuses an end before its start, and stays silent while either is incomplete", () => {
		expect(usDateNotBefore("03/31/2027")("03/01/2027")).toBe(
			DATE_ORDER_MESSAGE,
		);
		expect(usDateNotBefore("12/31/2026")("01/01/2027")).toBeUndefined();
		expect(usDateNotBefore("03/01/2027")("03/01/2027")).toBeUndefined();
		expect(usDateNotBefore("03/01/2027")("03/31/2027")).toBeUndefined();
		expect(usDateNotBefore("")("03/01/2027")).toBeUndefined();
		expect(usDateNotBefore("02/30/2027")("03/01/2027")).toBeUndefined();
	});

	it("composeRules reports the first failure only", () => {
		const rule = composeRules(required("Email is required."), email());

		expect(rule("")).toBe("Email is required.");
		expect(rule("tester@")).toBe(EMAIL_MESSAGE);
		expect(rule("tester@example.com")).toBeUndefined();
	});
});
