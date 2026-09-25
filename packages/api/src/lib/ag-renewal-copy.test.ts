import { describe, expect, it } from "vitest";

import { agRenewalNoticeText } from "./ag-renewal-copy";
import { renderTextEmail } from "./email-layout";

describe("agRenewalNoticeText", () => {
	const values = {
		customerName: "Kahale Farms",
		wpName: "Kalani Water Works",
		renewalDate: "2027-03-15",
	};

	it("names the customer, the purveyor and the renewal date", () => {
		const { subject, text } = agRenewalNoticeText(values);

		expect(subject).toContain("2027-03-15");
		expect(text).toContain("Hello Kahale Farms,");
		expect(text).toContain("2027-03-15");
		expect(text.split("\n").at(-1)).toBe("Kalani Water Works");
	});

	it("is inert once rendered, whatever the names contain", () => {
		const { subject, text } = agRenewalNoticeText({
			...values,
			customerName: "<script>alert(1)</script>",
			wpName: "A & B <b>Water</b>",
		});
		const html = renderTextEmail({ subject, text });

		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>Water</b>");
		expect(html).toContain("&lt;script&gt;");
	});
});
