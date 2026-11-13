/**
 * The landing page's "Contact Us" inquiry: its limits, its input schema, and
 * the email it becomes.
 *
 * The form is public — anyone can fill it in without an account — so every
 * field is bounded here and escaped before it reaches the email HTML. Nothing
 * is stored: the inquiry exists only as the message sent to the inbox below.
 *
 * Pure apart from the constants: no I/O, no env, no provider.
 */

import { z } from "zod";

import { CONTACT_INQUIRY_LIMITS } from "./contact-inquiry-limits";
import {
	escapeHtml,
	renderEmailLayout,
	renderEmailParagraph,
} from "./email-layout";

/** Where every inquiry is delivered. Named by the client in the ticket. */
export const CONTACT_INQUIRY_RECIPIENT = "backflowreporter@gmail.com";

/**
 * `website` is a honeypot: the field is in the form but hidden from people, so
 * only a bot that fills every input sends a value. (The form names the DOM
 * input something no browser autofills; `website` is only the wire name.) It is accepted by the schema
 * — a bot is not told it was caught — and the procedure drops the inquiry.
 */
export const contactInquiryInput = z.object({
	name: z.string().trim().min(1).max(CONTACT_INQUIRY_LIMITS.name),
	organization: z
		.string()
		.trim()
		.max(CONTACT_INQUIRY_LIMITS.organization)
		.default(""),
	// Trimmed before the format check, not after: `z.email().trim()` validates
	// first, so an autofilled trailing space the client accepts would be refused.
	email: z.string().trim().pipe(z.email().max(CONTACT_INQUIRY_LIMITS.email)),
	message: z.string().trim().min(1).max(CONTACT_INQUIRY_LIMITS.message),
	website: z.string().max(500).optional(),
});

export type ContactInquiry = z.infer<typeof contactInquiryInput>;

/** True when the hidden honeypot field carries anything. */
export function isLikelyBot(inquiry: Pick<ContactInquiry, "website">): boolean {
	return (inquiry.website ?? "").trim().length > 0;
}

/** Subject line. Names the sender so inquiries are told apart in the inbox. */
export function contactInquirySubject(inquiry: ContactInquiry): string {
	const who = inquiry.organization
		? `${inquiry.name} (${inquiry.organization})`
		: inquiry.name;

	// Header injection is the provider's problem to refuse, but a newline in a
	// subject is never intended — collapse whitespace so it reads as one line.
	return `New inquiry from ${who}`.replace(/\s+/g, " ");
}

/**
 * The inquiry as a complete email document. Every value is escaped; the
 * message keeps its line breaks.
 */
export function renderContactInquiryEmail(inquiry: ContactInquiry): string {
	const row = (label: string, valueHtml: string) =>
		`<tr><td style="padding:4px 16px 4px 0;font-size:14px;line-height:20px;color:#546474;vertical-align:top;white-space:nowrap;">${label}</td><td style="padding:4px 0;font-size:14px;line-height:20px;color:#1B242D;vertical-align:top;">${valueHtml}</td></tr>`;

	const emailHtml = escapeHtml(inquiry.email);
	const messageHtml = escapeHtml(inquiry.message).replace(/\r?\n/g, "<br>");

	const bodyHtml = [
		renderEmailParagraph(
			"Someone sent an inquiry through the Contact Us form on the landing page.",
		),
		'<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">',
		row("Name", escapeHtml(inquiry.name)),
		row("Organization", escapeHtml(inquiry.organization || "—")),
		row(
			"Email",
			`<a href="mailto:${emailHtml}" style="color:#0E5A81;text-decoration:underline;">${emailHtml}</a>`,
		),
		"</table>",
		renderEmailParagraph("Message", { muted: true }),
		renderEmailParagraph(messageHtml),
	].join("\n");

	return renderEmailLayout({
		title: contactInquirySubject(inquiry),
		heading: "New landing page inquiry",
		bodyHtml,
	});
}
