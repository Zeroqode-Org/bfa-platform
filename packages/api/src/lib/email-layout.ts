/**
 * The shared HTML shell every outbound email is rendered into.
 *
 * Feature code builds a *safe* body fragment — the escaped output of
 * `templateToHtml`, or markup assembled here from escaped values — and this
 * module wraps it in one Backflow Assembly Platform layout: a text wordmark header, a
 * white content card, and a one-line footer. The finished document is what goes
 * into `EmailMessage.html`; `email.ts` delivers it and knows nothing about how
 * it was made.
 *
 * Built for email clients rather than browsers, deliberately conservatively:
 *
 * - Table-based outer layout and inline styles on every element that carries a
 *   visual rule. The one `<style>` block is progressive enhancement only — a
 *   narrow-screen padding tweak and paragraph spacing for clients that honour
 *   it; nothing depends on it.
 * - No images, remote fonts, stylesheets, tracking pixels or rewritten links.
 *   The brand is the words "Backflow Assembly Platform" in text until the client supplies
 *   a logo asset, so no information is carried by an image.
 * - A system font stack, a fluid card capped at 600px (fixed at 600 for Outlook
 *   through a conditional table), and colours from the design system.
 *
 * Server-side and pure: no I/O, no env, no provider.
 */

import { templateToHtml } from "./notice-variables";

export const EMAIL_BRAND_NAME = "Backflow Assembly Platform";

const FONT_STACK =
	"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Design-system tokens, resolved to literal values because email clients do
 * not support CSS variables.
 *
 * Two deliberate departures, both for WCAG AA contrast: the CTA fill is the
 * primary *hover* shade, because white on `#1588C1` is roughly 3.9:1 and fails
 * for body-size text while `#11719E` is roughly 5.4:1; and footer text is a
 * darkened secondary, because `#687A8D` on the page background falls under
 * 4.5:1. The brighter primary survives only as the card's decorative top bar.
 */
const COLORS = {
	page: "#F5F8FA",
	card: "#FFFFFF",
	border: "#E1E6EA",
	divider: "#EEF1F4",
	accent: "#1588C1",
	button: "#11719E",
	buttonText: "#FFFFFF",
	wordmark: "#0E5A81",
	link: "#0E5A81",
	text: "#1B242D",
	muted: "#546474",
} as const;

/** Escapes text for element content and double-quoted attribute values. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Validates a link target and returns it escaped for an `href` attribute.
 *
 * Only absolute `http:` and `https:` URLs are accepted. A link in an email is
 * opened outside the application, so a relative path means nothing there, and
 * any other scheme — `javascript:`, `data:` — has no business in a message.
 * Throws rather than dropping the link: an invitation without a working link is
 * not an invitation, and `sendEmail` should never be reached with one.
 */
export function emailHref(url: string): string {
	let parsed: URL;

	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Email links must be absolute http(s) URLs.");
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Email links must be absolute http(s) URLs.");
	}

	return escapeHtml(url);
}

/**
 * A paragraph around an already-safe fragment. Pass `escapeHtml(text)` for
 * plain text; the fragment is inserted as given.
 */
export function renderEmailParagraph(
	safeHtml: string,
	{ muted = false }: { muted?: boolean } = {},
): string {
	const style = muted
		? `margin:0 0 16px;font-size:14px;line-height:20px;color:${COLORS.muted};`
		: `margin:0 0 16px;font-size:16px;line-height:24px;color:${COLORS.text};`;

	return `<p style="${style}">${safeHtml}</p>`;
}

export type CallToActionInput = {
	/** Absolute http(s) URL. Validated and escaped here. */
	href: string;
	/** Plain text. Escaped here. Should say what the link does. */
	label: string;
	/** Plain text shown above the visible fallback URL. Escaped here. */
	fallbackIntro?: string;
};

/**
 * A button-styled link followed by the same URL as visible, selectable text.
 *
 * The button is a padded `<a>` in a filled table cell — the arrangement that
 * survives clients that ignore padding on inline elements, and it is still a
 * real link with its label as text, so screen readers announce what it does.
 * The fallback URL is always shown: a client that mangles the button, a reader
 * who wants to see where a link goes before opening it, and the console
 * driver's log line all need the address itself.
 */
export function renderCallToAction({
	href,
	label,
	fallbackIntro = "If the button does not work, copy and paste this link into your browser:",
}: CallToActionInput): string {
	const safeHref = emailHref(href);

	return [
		'<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border-collapse:separate;">',
		"<tr>",
		`<td align="center" bgcolor="${COLORS.button}" style="border-radius:8px;background-color:${COLORS.button};">`,
		`<a href="${safeHref}" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:16px;font-weight:600;line-height:20px;color:${COLORS.buttonText};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>`,
		"</td>",
		"</tr>",
		"</table>",
		`<p style="margin:0 0 4px;font-size:14px;line-height:20px;color:${COLORS.muted};">${escapeHtml(fallbackIntro)}</p>`,
		`<p style="margin:0 0 16px;font-size:14px;line-height:20px;word-break:break-all;"><a href="${safeHref}" style="color:${COLORS.link};text-decoration:underline;">${safeHref}</a></p>`,
	].join("\n");
}

export type EmailLayoutInput = {
	/**
	 * Plain text. The document `<title>` and the message's accessible name —
	 * normally the subject. Escaped here. Not rendered in the body.
	 */
	title: string;
	/** Plain text. Rendered as the message's one `<h1>` when given. Escaped here. */
	heading?: string;
	/**
	 * An HTML fragment that is already safe: the output of `templateToHtml`, or
	 * markup built from this module's helpers and {@link escapeHtml}. Inserted
	 * as given — never pass unescaped user input.
	 */
	bodyHtml: string;
};

/**
 * Progressive enhancement only. Written with spaces inside every brace pair so
 * no `{{` ever appears in a rendered message, where it would read as an
 * unresolved placeholder.
 */
const HEAD_STYLE = [
	".bfr-body p { margin: 0 0 16px; }",
	"@media only screen and (max-width: 620px) { .bfr-pad { padding-left: 20px !important; padding-right: 20px !important; } }",
].join(" ");

/** Wraps a safe body fragment in the complete Backflow Assembly Platform email document. */
export function renderEmailLayout({
	title,
	heading,
	bodyHtml,
}: EmailLayoutInput): string {
	const safeTitle = escapeHtml(title);
	const headingHtml = heading
		? `<h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;line-height:30px;font-weight:700;color:${COLORS.text};">${escapeHtml(heading)}</h1>`
		: "";

	return [
		"<!DOCTYPE html>",
		'<html lang="en" dir="ltr">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="x-apple-disable-message-reformatting">',
		'<meta name="color-scheme" content="light">',
		'<meta name="supported-color-schemes" content="light">',
		`<title>${safeTitle}</title>`,
		`<style>${HEAD_STYLE}</style>`,
		"</head>",
		`<body style="margin:0;padding:0;width:100%;background-color:${COLORS.page};">`,
		`<div role="article" aria-roledescription="email" aria-label="${safeTitle}" lang="en" dir="ltr">`,
		`<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;background-color:${COLORS.page};">`,
		"<tr>",
		'<td align="center" style="padding:32px 12px;">',
		'<!--[if mso]><table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->',
		`<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:separate;background-color:${COLORS.card};border:1px solid ${COLORS.border};border-top:4px solid ${COLORS.accent};border-radius:12px;">`,
		"<tr>",
		`<td class="bfr-pad" style="padding:20px 32px;border-bottom:1px solid ${COLORS.divider};font-family:${FONT_STACK};font-size:18px;line-height:24px;font-weight:700;color:${COLORS.wordmark};text-align:left;">${EMAIL_BRAND_NAME}</td>`,
		"</tr>",
		"<tr>",
		`<td class="bfr-pad bfr-body" style="padding:32px;font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${COLORS.text};text-align:left;">`,
		headingHtml,
		bodyHtml,
		"</td>",
		"</tr>",
		"</table>",
		'<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">',
		"<tr>",
		`<td class="bfr-pad" style="padding:20px 32px 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${COLORS.muted};text-align:center;">Sent through ${EMAIL_BRAND_NAME}.</td>`,
		"</tr>",
		"</table>",
		"<!--[if mso]></td></tr></table><![endif]-->",
		"</td>",
		"</tr>",
		"</table>",
		"</div>",
		"</body>",
		"</html>",
	]
		.filter((line) => line !== "")
		.join("\n");
}

/**
 * A plain-text message — a general-info broadcast today, an automated notice
 * once Workflow 1 sends them — as a complete email document.
 *
 * The text goes through `templateToHtml` unchanged, which escapes all of it and
 * turns line breaks into paragraphs; the layout adds only the shell around that
 * fragment. The subject is the document title and is not repeated in the body,
 * so what the recipient reads is exactly the text that was written.
 */
export function renderTextEmail({
	subject,
	text,
}: {
	subject: string;
	text: string;
}): string {
	return renderEmailLayout({ title: subject, bodyHtml: templateToHtml(text) });
}
