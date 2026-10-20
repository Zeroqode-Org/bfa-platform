import { describe, expect, it } from "vitest";

import {
	CERTIFIER_LIST_HEADING,
	certifierListLine,
	certifierListText,
} from "./notice-defaults";

/**
 * The tester block appended to a reminder.
 *
 * Deliberately not a template variable: {@link NOTICE_VARIABLES} is a closed
 * registry whose final contents are still a client decision, so the list is
 * appended below whatever the purveyor wrote rather than depending on them
 * having typed a placeholder.
 */
describe("certifierListLine", () => {
	it("joins company, name and licence number", () => {
		expect(
			certifierListLine({
				fullName: "Alana Kealoha",
				company: "Island Backflow",
				idNumber: "HI-4471",
			}),
		).toBe("Island Backflow — Alana Kealoha — HI-4471");
	});

	it("skips whatever is missing rather than leaving empty separators", () => {
		expect(
			certifierListLine({
				fullName: "Alana Kealoha",
				company: null,
				idNumber: "HI-4471",
			}),
		).toBe("Alana Kealoha — HI-4471");

		expect(
			certifierListLine({ fullName: null, company: "  ", idNumber: "HI-4471" }),
		).toBe("HI-4471");
	});

	it("is empty when there is nothing to say about a tester", () => {
		expect(
			certifierListLine({ fullName: null, company: null, idNumber: null }),
		).toBe("");
	});
});

describe("certifierListText", () => {
	it("heads the list and bullets each tester", () => {
		const text = certifierListText([
			{ fullName: "Alana Kealoha", company: "Island Backflow", idNumber: null },
			{ fullName: "Kenji Watanabe", company: null, idNumber: "HI-8802" },
		]);

		expect(text).toBe(
			[
				CERTIFIER_LIST_HEADING,
				"- Island Backflow — Alana Kealoha",
				"- Kenji Watanabe — HI-8802",
			].join("\n"),
		);
	});

	it("is null when nobody is authorized, so no empty heading is appended", () => {
		expect(certifierListText([])).toBeNull();
		expect(
			certifierListText([{ fullName: null, company: null, idNumber: null }]),
		).toBeNull();
	});
});
