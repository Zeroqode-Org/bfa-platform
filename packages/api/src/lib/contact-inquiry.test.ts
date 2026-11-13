import { describe, expect, it } from "vitest";

import {
	contactInquiryInput,
	contactInquirySubject,
	isLikelyBot,
	renderContactInquiryEmail,
} from "./contact-inquiry";
import { CONTACT_INQUIRY_LIMITS } from "./contact-inquiry-limits";

const valid = {
	name: "Jane Doe",
	organization: "Riverside Water",
	email: "jane@riverside.gov",
	message: "Hello",
};

describe("contactInquiryInput", () => {
	it("accepts a complete inquiry and trims it", () => {
		const parsed = contactInquiryInput.parse({
			...valid,
			name: "  Jane Doe  ",
		});

		expect(parsed.name).toBe("Jane Doe");
	});

	it("trims an email address before checking its format", () => {
		const parsed = contactInquiryInput.parse({
			...valid,
			email: " jane@riverside.gov ",
		});

		expect(parsed.email).toBe("jane@riverside.gov");
	});

	it("treats organization as optional", () => {
		const { organization: _, ...rest } = valid;

		expect(contactInquiryInput.parse(rest).organization).toBe("");
	});

	it.each([
		["a blank name", { name: "   " }],
		["a malformed email", { email: "not-an-email" }],
		["an empty message", { message: "" }],
		[
			"a message over the limit",
			{ message: "x".repeat(CONTACT_INQUIRY_LIMITS.message + 1) },
		],
	])("refuses %s", (_label, override) => {
		expect(
			contactInquiryInput.safeParse({ ...valid, ...override }).success,
		).toBe(false);
	});
});

describe("isLikelyBot", () => {
	it("is false when the honeypot is empty or absent", () => {
		expect(isLikelyBot({})).toBe(false);
		expect(isLikelyBot({ website: "  " })).toBe(false);
	});

	it("is true when the honeypot carries a value", () => {
		expect(isLikelyBot({ website: "https://spam.example" })).toBe(true);
	});
});

describe("contactInquirySubject", () => {
	it("names the sender and organization on one line", () => {
		const inquiry = contactInquiryInput.parse({
			...valid,
			name: "Jane\nDoe",
		});

		expect(contactInquirySubject(inquiry)).toBe(
			"New inquiry from Jane Doe (Riverside Water)",
		);
	});

	it("omits the organization when none was given", () => {
		const inquiry = contactInquiryInput.parse({ ...valid, organization: "" });

		expect(contactInquirySubject(inquiry)).toBe("New inquiry from Jane Doe");
	});
});

describe("renderContactInquiryEmail", () => {
	it("escapes every visitor-supplied value", () => {
		const html = renderContactInquiryEmail(
			contactInquiryInput.parse({
				...valid,
				name: "<script>alert(1)</script>",
				message: 'Hi <img src=x onerror="x">',
			}),
		);

		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;script&gt;");
	});

	it("keeps the message's line breaks and links the reply address", () => {
		const html = renderContactInquiryEmail(
			contactInquiryInput.parse({ ...valid, message: "Line one\nLine two" }),
		);

		expect(html).toContain("Line one<br>Line two");
		expect(html).toContain('href="mailto:jane@riverside.gov"');
	});
});
