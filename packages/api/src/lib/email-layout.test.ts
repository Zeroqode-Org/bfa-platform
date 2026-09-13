import { describe, expect, it } from "vitest";

import {
	EMAIL_BRAND_NAME,
	emailHref,
	escapeHtml,
	renderCallToAction,
	renderEmailLayout,
	renderEmailParagraph,
	renderTextEmail,
} from "./email-layout";
import { templateToHtml } from "./notice-variables";

/**
 * The shared email shell on its own — pure string rendering, no driver, no
 * network, no credentials.
 */

describe("renderEmailLayout", () => {
	const html = renderEmailLayout({
		title: "A subject line",
		heading: "A heading",
		bodyHtml: "<p>Body fragment</p>",
	});

	it("is a complete, language-tagged HTML document", () => {
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain('<html lang="en" dir="ltr">');
		expect(html).toContain('<meta name="viewport"');
		expect(html).toContain("<title>A subject line</title>");
		expect(html.trimEnd().endsWith("</html>")).toBe(true);
	});

	it("has a text wordmark header, the body and a footer, in that order", () => {
		const header = html.indexOf(`>${EMAIL_BRAND_NAME}</td>`);
		const body = html.indexOf("<p>Body fragment</p>");
		const footer = html.indexOf(`Sent through ${EMAIL_BRAND_NAME}.`);

		expect(header).toBeGreaterThan(-1);
		expect(body).toBeGreaterThan(header);
		expect(footer).toBeGreaterThan(body);
	});

	it("renders the heading as the message's only h1", () => {
		expect(html.match(/<h1\b/g)).toHaveLength(1);
		expect(html).toMatch(/<h1[^>]*>A heading<\/h1>/);
	});

	it("omits the h1 entirely when there is no heading", () => {
		expect(
			renderEmailLayout({ title: "Subject", bodyHtml: "<p>x</p>" }),
		).not.toContain("<h1");
	});

	it("uses presentation tables and inline styles for the outer layout", () => {
		expect(html).toContain('<table role="presentation"');
		expect(html).toMatch(/max-width:600px/);
		expect(html).toContain("background-color:#FFFFFF");
	});

	it("loads nothing external and tracks nothing", () => {
		expect(html).not.toMatch(/<img\b/i);
		expect(html).not.toMatch(/<link\b/i);
		expect(html).not.toMatch(/<script\b/i);
		expect(html).not.toMatch(/\bsrc=/i);
		expect(html).not.toMatch(/url\(/i);
		expect(html).not.toMatch(/@import/i);
		expect(html).not.toMatch(/https?:\/\//i);
	});

	it("never contains a double brace a reader could mistake for a placeholder", () => {
		expect(html).not.toContain("{{");
		expect(html).not.toContain("}}");
	});

	it("escapes the title and heading, including where the title is an attribute", () => {
		const hostile = renderEmailLayout({
			title: '"><script>alert(1)</script>',
			heading: "<img src=x onerror=alert(1)>",
			bodyHtml: "<p>ok</p>",
		});

		expect(hostile).not.toContain("<script>");
		expect(hostile).not.toContain("<img");
		expect(hostile).toContain(
			'aria-label="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
		);
		expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});
});

describe("renderCallToAction", () => {
	const href = "https://app.backflowreporter.io/invite/abc_DEF-123";
	const html = renderCallToAction({ href, label: "Set up your account" });

	it("renders a button-styled link with a descriptive text label", () => {
		expect(html).toMatch(
			/<a href="https:\/\/app\.backflowreporter\.io\/invite\/abc_DEF-123" style="[^"]*">Set up your account<\/a>/,
		);
		expect(html).toContain("background-color:#11719E");
	});

	it("follows the button with the same URL as visible text", () => {
		const button = html.indexOf(">Set up your account</a>");
		const fallback = html.indexOf(`>${href}</a>`);

		expect(button).toBeGreaterThan(-1);
		expect(fallback).toBeGreaterThan(button);
		expect(html).toContain(
			"If the button does not work, copy and paste this link into your browser:",
		);
	});

	it("escapes the URL in both the attribute and the visible text", () => {
		const withQuery = renderCallToAction({
			href: 'https://example.com/path?a=1&b="2"',
			label: "Open <this>",
		});

		expect(withQuery).toContain(
			'href="https://example.com/path?a=1&amp;b=&quot;2&quot;"',
		);
		expect(withQuery).toContain(
			">https://example.com/path?a=1&amp;b=&quot;2&quot;</a>",
		);
		expect(withQuery).not.toMatch(/b="2"/);
		expect(withQuery).toContain(">Open &lt;this&gt;</a>");
	});

	it.each([
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"/invite/relative",
		"not a url",
	])("refuses %s as a link target", (target) => {
		expect(() => renderCallToAction({ href: target, label: "Go" })).toThrow(
			/absolute http\(s\) URLs/,
		);
	});
});

describe("emailHref", () => {
	it("accepts http for the local console-driver link", () => {
		expect(emailHref("http://localhost:3001/invite/x")).toBe(
			"http://localhost:3001/invite/x",
		);
	});
});

describe("escapeHtml", () => {
	it("escapes every character that can break out of text or an attribute", () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});
});

describe("renderEmailParagraph", () => {
	it("inserts the safe fragment it is given, with inline styles", () => {
		expect(renderEmailParagraph(escapeHtml("a < b"))).toMatch(
			/^<p style="[^"]+">a &lt; b<\/p>$/,
		);
	});
});

describe("renderTextEmail", () => {
	it("wraps templateToHtml's output unchanged inside the shared shell", () => {
		const text = "Hello Ada,\n\nYour update.";
		const html = renderTextEmail({ subject: "News", text });

		expect(html).toContain(templateToHtml(text));
		expect(html).toContain(`>${EMAIL_BRAND_NAME}</td>`);
		expect(html).toContain(`Sent through ${EMAIL_BRAND_NAME}.`);
		expect(html).toContain("<title>News</title>");
	});

	it("does not repeat the subject as a heading in the body", () => {
		expect(
			renderTextEmail({ subject: "News", text: "Body only" }),
		).not.toContain("<h1");
	});
});
