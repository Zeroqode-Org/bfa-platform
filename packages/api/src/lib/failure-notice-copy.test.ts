import { describe, expect, it } from "vitest";

import { renderTextEmail } from "./email-layout";
import {
	failureNoticeText,
	REPAIR_COMPANY_LIST_HEADING,
	repairCompanyListLine,
	repairCompanyListText,
} from "./failure-notice-copy";

describe("repairCompanyListLine", () => {
	it("joins name and phone with an em dash", () => {
		expect(
			repairCompanyListLine({
				companyName: "Aloha Backflow Repair",
				phone: "(808) 555-0100",
			}),
		).toBe("Aloha Backflow Repair — (808) 555-0100");
	});

	it("renders a company with no phone from its name alone", () => {
		expect(
			repairCompanyListLine({ companyName: "Valve Works", phone: null }),
		).toBe("Valve Works");
		expect(
			repairCompanyListLine({ companyName: "Valve Works", phone: "  " }),
		).toBe("Valve Works");
	});
});

describe("repairCompanyListText", () => {
	it("returns null when there is nobody to list, so no empty heading ships", () => {
		expect(repairCompanyListText([])).toBeNull();
	});

	it("renders the heading and one bullet per company", () => {
		const text = repairCompanyListText([
			{ companyName: "Aloha Backflow Repair", phone: "(808) 555-0100" },
			{ companyName: "Valve Works", phone: null },
		]);

		expect(text).toBe(
			[
				REPAIR_COMPANY_LIST_HEADING,
				"- Aloha Backflow Repair — (808) 555-0100",
				"- Valve Works",
			].join("\n"),
		);
	});

	it("has no email field to render — the entry type carries name and phone only", () => {
		// A compile-level fact restated as a runtime one: even an object that
		// arrives with extra keys contributes nothing but name and phone.
		const line = repairCompanyListLine({
			companyName: "Leaky Co",
			phone: "555-1",
			...({ email: "leak@example.com" } as object),
		});

		expect(line).not.toContain("leak@example.com");
	});
});

describe("failureNoticeText", () => {
	const values = {
		customerName: "Marta Ellison",
		wpName: "Kalani Water Works",
		bfaType: "RP",
		bin: "BIN-77",
		serviceAddress: "12 Kalani Street",
		testDate: "2026-09-11",
	};

	it("names the assembly, the address and the test date", () => {
		const { subject, text } = failureNoticeText(values);

		expect(subject).toBe("Backflow assembly test failed — 12 Kalani Street");
		expect(text).toContain("Hello Marta Ellison,");
		expect(text).toContain("RP backflow assembly at 12 Kalani Street");
		expect(text).toContain("(BIN BIN-77)");
		expect(text).toContain("tested on 2026-09-11 and did not pass");
		expect(text).toContain("Kalani Water Works");
	});

	it("omits the date clause when the submission has no test date", () => {
		const { text } = failureNoticeText({ ...values, testDate: null });

		expect(text).toContain("was tested and did not pass");
		expect(text).not.toContain("tested on");
	});

	it("is escaped by the shared rendering path, not trusted as HTML", () => {
		const { subject, text } = failureNoticeText({
			...values,
			customerName: "Ampersand & <script>Co</script>",
		});
		const html = renderTextEmail({ subject, text });

		expect(html).not.toContain("<script>Co</script>");
		expect(html).toContain("&lt;script&gt;Co&lt;/script&gt;");
	});
});
