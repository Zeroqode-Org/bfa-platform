/**
 * The words of the AG rate renewal notice (Workflow 2).
 *
 * Imports nothing, for the reason `failure-notice-copy.ts` imports nothing:
 * pure text assembly is testable without a database, and nothing here escapes
 * anything — the assembled plain text goes through `renderTextEmail`, whose
 * `templateToHtml` escapes all of it, the same single rendering path every
 * automated message takes.
 *
 * There is deliberately no `notice_templates` row and no editor for this text.
 * The `notice_type` enum names the four escalation stages and nothing else; a
 * configurable renewal template is not a specified feature.
 *
 * ---------------------------------------------------------------------------
 * PROVISIONAL PRODUCT COPY — NOT APPROVED FOR PRODUCTION.
 *
 * A plain reminder of the renewal date the purveyor's own records hold. It
 * refers to the customer's agricultural water rate ("To keep the agricultural
 * rate…") and asks them to contact the purveyor about renewing it; it quotes
 * no rate amount and cites no regulation. That wording is a placeholder, not
 * client-approved policy. The client supplies or approves the customer-facing
 * words before a production tenant sends one; replacing them is an edit to
 * this file.
 * ---------------------------------------------------------------------------
 */

export type AgRenewalNoticeValues = {
	customerName: string;
	wpName: string;
	/** `customers.ag_renewal_date`, a `YYYY-MM-DD` Hawaii calendar day. */
	renewalDate: string;
};

/** Subject and plain-text body of one AG rate renewal notice. */
export function agRenewalNoticeText(values: AgRenewalNoticeValues): {
	subject: string;
	text: string;
} {
	return {
		subject: `Agricultural rate renewal — ${values.renewalDate}`,
		text: [
			`Hello ${values.customerName},`,
			"",
			`Our records show ${values.renewalDate} as the renewal date for the agricultural water rate on your account.`,
			"",
			`To keep the agricultural rate, please contact ${values.wpName} about renewing it. If you have already renewed, no further action is needed.`,
			"",
			"Thank you,",
			values.wpName,
		].join("\n"),
	};
}
