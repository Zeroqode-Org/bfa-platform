/**
 * The four automated notice types, and the platform's own text for each.
 *
 * Imports nothing, for the same reason `asset-field-limits.ts` imports
 * nothing: the notices editor is a client component that renders these labels
 * and this fallback copy, and reaching for the Drizzle enum here would pull the
 * schema — and Drizzle with it — into the browser bundle.
 *
 * The list below is still checked against the database enum rather than merely
 * matching it by eye: `routers/notices.ts` builds its response by mapping over
 * `noticeTypeValues` from the schema and indexing
 * {@link PLATFORM_DEFAULT_NOTICE_TEMPLATES} with each value, so a type added to
 * one list and not the other stops compiling.
 *
 * ---------------------------------------------------------------------------
 * PROVISIONAL PRODUCT COPY — NOT APPROVED FOR PRODUCTION.
 *
 * The PRD, the build plan and the prototype all specify the *mechanism* — a
 * missing `notice_templates` row falls back to a platform default rather than
 * sending blank — and none of them specifies the words. What is below is
 * deliberately plain: it states the facts the purveyor's own records supply and
 * makes no compliance claim, quotes no regulation, names no penalty and
 * threatens no interruption of service, because inventing any of those would
 * put words in a water purveyor's mouth that they are answerable for.
 *
 * Before this ships to a production tenant the client has to supply or approve
 * the customer-facing text for all four types. Replacing it is an edit to this
 * one file: nothing else in the feature contains notice copy.
 * ---------------------------------------------------------------------------
 *
 * Every default is written in the same placeholders the editor offers, so the
 * first thing a purveyor sees when they open an untouched template is a worked
 * example of the substitution they are about to edit.
 */

/** Escalation order — the order the editor lists them in. */
export const NOTICE_TYPES = [
	"reminder",
	"late_notice_1",
	"late_notice_2",
	"final_notice",
] as const;

export type NoticeType = (typeof NOTICE_TYPES)[number];

export type NoticeTemplateCopy = {
	subject: string;
	body: string;
};

/** Human labels for the four types. */
export const NOTICE_TYPE_LABELS: Record<NoticeType, string> = {
	reminder: "Reminder",
	late_notice_1: "Late Notice 1",
	late_notice_2: "Late Notice 2",
	final_notice: "Final Notice",
};

/** One line per type saying when it is sent, for the editor's description. */
export const NOTICE_TYPE_DESCRIPTIONS: Record<NoticeType, string> = {
	reminder: "Sent ahead of the annual test due date.",
	late_notice_1: "The first notice after a test due date has passed.",
	late_notice_2: "The second notice, when the assembly is still untested.",
	final_notice: "The last notice in the escalation chain.",
};

export const PLATFORM_DEFAULT_NOTICE_TEMPLATES: Record<
	NoticeType,
	NoticeTemplateCopy
> = {
	reminder: {
		subject: "Annual backflow test due {{due_date}} — {{service_address}}",
		body: [
			"Hello {{customer_name}},",
			"",
			"Our records show that the {{bfa_type}} backflow assembly at {{service_address}} (BIN {{bin}}) is due for its annual test on {{due_date}}.",
			"",
			"Please arrange the test with a certified tester and ask them to file the results with us.",
			"",
			"Thank you,",
			"{{wp_name}}",
		].join("\n"),
	},
	late_notice_1: {
		subject: "Backflow test overdue — {{service_address}}",
		body: [
			"Hello {{customer_name}},",
			"",
			"The annual test for the {{bfa_type}} backflow assembly at {{service_address}} (BIN {{bin}}) was due on {{due_date}}, and we have not yet received the results.",
			"",
			"Please arrange the test with a certified tester and ask them to file the results with us.",
			"",
			"Thank you,",
			"{{wp_name}}",
		].join("\n"),
	},
	late_notice_2: {
		subject: "Second notice: backflow test overdue — {{service_address}}",
		body: [
			"Hello {{customer_name}},",
			"",
			"This is our second notice about the {{bfa_type}} backflow assembly at {{service_address}} (BIN {{bin}}). Its annual test was due on {{due_date}} and we still have no results on file.",
			"",
			"Please arrange the test with a certified tester as soon as you can. If the test has already been carried out, ask the tester to send us the results.",
			"",
			"Thank you,",
			"{{wp_name}}",
		].join("\n"),
	},
	final_notice: {
		subject: "Final notice: backflow test overdue — {{service_address}}",
		body: [
			"Hello {{customer_name}},",
			"",
			"This is the final notice in our reminder sequence for the {{bfa_type}} backflow assembly at {{service_address}} (BIN {{bin}}). Its annual test was due on {{due_date}} and we have no results on file.",
			"",
			"Please contact us so we can agree how the test will be completed.",
			"",
			"Thank you,",
			"{{wp_name}}",
		].join("\n"),
	},
};

export function platformDefaultTemplate(
	noticeType: NoticeType,
): NoticeTemplateCopy {
	return PLATFORM_DEFAULT_NOTICE_TEMPLATES[noticeType];
}
