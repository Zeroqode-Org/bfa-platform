/**
 * The words of the failure notice, and the repair-company block it carries.
 *
 * Imports nothing, for the reason `notice-defaults.ts` imports nothing: pure
 * text assembly is testable without a database, and nothing here escapes
 * anything — the assembled plain text goes through `renderTextEmail`, whose
 * `templateToHtml` escapes all of it, the same single rendering path every
 * automated notice takes.
 *
 * There is deliberately no `notice_templates` row and no editor for this text.
 * The `notice_type` enum names the four escalation stages and nothing else; a
 * configurable failure template is not a specified feature, and building one by
 * accident here would be building it without a product decision behind it.
 *
 * ---------------------------------------------------------------------------
 * PROVISIONAL PRODUCT COPY — NOT APPROVED FOR PRODUCTION.
 *
 * Plain statements of what the purveyor's own records say, in the same
 * register as `notice-defaults.ts`: no compliance claim, no regulation quoted,
 * no penalty named. The client supplies or approves the customer-facing words
 * before a production tenant sends one; replacing them is an edit to this file.
 * ---------------------------------------------------------------------------
 */

/**
 * A repair company as the email is allowed to know it: name and phone.
 *
 * There is intentionally no `email` field on this type. The build plan's rule
 * is that a customer contacts a repair company by name and phone; a repair
 * company's email address is the purveyor's contact detail, not the
 * customer's, and never appears in this message. Keeping the field off the
 * type means a query that selected it could not be rendered by mistake.
 */
export type RepairCompanyListEntry = {
	companyName: string;
	phone: string | null;
};

export const REPAIR_COMPANY_LIST_HEADING =
	"Repair companies this water purveyor works with:";

/** One company's line: name, then phone when there is one. */
export function repairCompanyListLine(entry: RepairCompanyListEntry): string {
	const name = entry.companyName.trim();
	const phone = entry.phone?.trim();

	return phone ? `${name} — ${phone}` : name;
}

/**
 * The whole repair-company block as plain text, or `null` when the purveyor
 * has nobody active to list — in which case the notice goes out without the
 * block rather than with an empty heading. Resolved at send time by the
 * caller; nothing here caches or stores a list.
 */
export function repairCompanyListText(
	entries: readonly RepairCompanyListEntry[],
): string | null {
	const lines = entries
		.map((entry) => repairCompanyListLine(entry))
		.filter((line) => line.length > 0)
		.map((line) => `- ${line}`);

	return lines.length === 0
		? null
		: [REPAIR_COMPANY_LIST_HEADING, ...lines].join("\n");
}

export type FailureNoticeValues = {
	customerName: string;
	wpName: string;
	bfaType: string;
	bin: string;
	serviceAddress: string;
	/** `test_date` as the certifier recorded it, or null when the row has none. */
	testDate: string | null;
};

/**
 * Subject and plain-text body of one failure notice. The repair-company block
 * is appended by the caller (it may be absent); everything is escaped later by
 * the rendering path, so markup in a customer or purveyor name is inert.
 */
export function failureNoticeText(values: FailureNoticeValues): {
	subject: string;
	text: string;
} {
	const testedOn = values.testDate ? ` on ${values.testDate}` : "";

	return {
		subject: `Backflow assembly test failed — ${values.serviceAddress}`,
		text: [
			`Hello ${values.customerName},`,
			"",
			`The ${values.bfaType} backflow assembly at ${values.serviceAddress} (BIN ${values.bin}) was tested${testedOn} and did not pass.`,
			"",
			"The assembly needs to be repaired or replaced, and then re-tested by a certified tester. Once a passing test is filed with us, no further action is needed.",
			"",
			"Thank you,",
			values.wpName,
		].join("\n"),
	};
}
