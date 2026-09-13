import { describe, expect, it } from "vitest";

import { renderTextEmail } from "./email-layout";
import { NOTICE_TYPES, platformDefaultTemplate } from "./notice-defaults";
import {
	NOTICE_FIELD_LIMITS,
	sendGeneralInfoBroadcastInput,
	upsertNoticeTemplateInput,
} from "./notice-input";
import {
	AUTOMATED_NOTICE_VARIABLES,
	BROADCAST_VARIABLES,
	NOTICE_VARIABLE_KEYS,
	placeholdersIn,
	renderTemplate,
	sampleVariableValues,
	templateTextProblems,
	templateToHtml,
	variableKeys,
} from "./notice-variables";

/**
 * The substitution layer and the input rules on their own — no database, so
 * these run under a plain `npm test`.
 *
 * What is being pinned down here is the part that reaches a customer's inbox:
 * which placeholders resolve, which are refused and where, and what happens to
 * the ones that are neither.
 */

const allKeys = variableKeys(AUTOMATED_NOTICE_VARIABLES);
const broadcastKeys = variableKeys(BROADCAST_VARIABLES);

const sample = sampleVariableValues();

describe("renderTemplate", () => {
	it("substitutes every supported placeholder", () => {
		const rendered = renderTemplate(
			NOTICE_VARIABLE_KEYS.map((key) => `{{${key}}}`).join(" | "),
			sample,
			allKeys,
		);

		expect(rendered).toBe(
			NOTICE_VARIABLE_KEYS.map((key) => sample[key]).join(" | "),
		);
		expect(rendered).not.toContain("{{");
	});

	it("tolerates whitespace inside the braces", () => {
		expect(renderTemplate("Hi {{ customer_name }}", sample, allKeys)).toBe(
			`Hi ${sample.customer_name}`,
		);
	});

	it("leaves an unknown placeholder exactly as written", () => {
		// Blanking it would let a typo vanish into a sentence that still reads.
		// Visible is what makes it findable in the preview.
		expect(renderTemplate("Dear {{custmer_name}},", sample, allKeys)).toBe(
			"Dear {{custmer_name}},",
		);
	});

	it("never falls back to another variable's value", () => {
		const rendered = renderTemplate("{{bin}}", { customer_name: "Ada" }, [
			"bin",
		]);

		expect(rendered).toBe("{{bin}}");
		expect(rendered).not.toContain("Ada");
	});

	it("leaves a placeholder the caller did not allow here", () => {
		expect(renderTemplate("{{bin}}", sample, broadcastKeys)).toBe("{{bin}}");
	});

	it("does not rescan a substituted value", () => {
		// A customer whose name genuinely contains a placeholder gets their name,
		// not a second substitution — which is what a replace-per-variable loop
		// would do, and why this is one pass.
		const rendered = renderTemplate(
			"Hello {{customer_name}}",
			{ customer_name: "{{due_date}} Ltd", due_date: "2026-10-01" },
			allKeys,
		);

		expect(rendered).toBe("Hello {{due_date}} Ltd");
	});

	it("substitutes every occurrence, not only the first", () => {
		expect(
			renderTemplate("{{wp_name}} — {{wp_name}}", { wp_name: "Harbor" }, [
				"wp_name",
			]),
		).toBe("Harbor — Harbor");
	});

	it("leaves a placeholder whose value is missing or blank", () => {
		expect(renderTemplate("{{bin}}", { bin: "" }, allKeys)).toBe("{{bin}}");
		expect(renderTemplate("{{bin}}", {}, allKeys)).toBe("{{bin}}");
	});
});

describe("placeholdersIn", () => {
	it("lists each distinct name once, in the order written", () => {
		expect(placeholdersIn("{{bin}} {{customer_name}} {{bin}}")).toEqual([
			"bin",
			"customer_name",
		]);
	});
});

describe("templateTextProblems", () => {
	it("finds nothing in text using only the allowed variables", () => {
		expect(templateTextProblems("Hi {{customer_name}}", broadcastKeys)).toEqual(
			[],
		);
	});

	it("separates an unknown name from a real variable used in the wrong place", () => {
		expect(templateTextProblems("{{nope}} {{bin}}", broadcastKeys)).toEqual([
			{ kind: "unknown", placeholder: "nope" },
			{ kind: "not_allowed_here", placeholder: "bin" },
		]);
	});
});

describe("templateToHtml", () => {
	it("escapes markup rather than rendering it", () => {
		const html = templateToHtml("<script>alert(1)</script>");

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("escapes a value that arrived through substitution too", () => {
		const html = templateToHtml(
			renderTemplate("Hello {{customer_name}}", {
				customer_name: "<b>Ada</b>",
			}),
		);

		expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
	});

	it("turns line breaks into paragraphs", () => {
		expect(templateToHtml("one\ntwo")).toBe("<p>one</p>\n<p>two</p>");
	});
});

describe("notice text inside the shared email layout", () => {
	const hostileBody = [
		"Hello {{customer_name}},",
		'<script>alert("x")</script>',
		'<img src="https://evil.example/pixel.gif" onerror="alert(1)">',
		'<a href="https://evil.example">click</a> <b>bold</b> <style>body{}</style>',
	].join("\n");

	const html = renderTextEmail({
		subject: "Notice for {{customer_name}}",
		text: renderTemplate(
			hostileBody,
			{ customer_name: '<iframe src="https://evil.example"></iframe>' },
			allKeys,
		),
	});

	it("still escapes a script tag once wrapped", () => {
		expect(html).not.toMatch(/<script\b/i);
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	});

	it("still escapes arbitrary tags, typed or substituted", () => {
		expect(html).not.toMatch(/<img\b/i);
		expect(html).not.toMatch(/<iframe\b/i);
		expect(html).not.toMatch(/<b>/i);
		expect(html).not.toContain('href="https://evil.example"');
		expect(html).not.toContain('evil.example/pixel.gif"');
		expect(html).toContain(
			"&lt;img src=&quot;https://evil.example/pixel.gif&quot;",
		);
		expect(html).toContain(
			"&lt;iframe src=&quot;https://evil.example&quot;&gt;",
		);
	});

	it("carries the text through templateToHtml byte for byte", () => {
		const rendered = renderTemplate("Line one\n\nLine three", sample, allKeys);

		expect(renderTextEmail({ subject: "s", text: rendered })).toContain(
			templateToHtml(rendered),
		);
	});

	it("escapes the subject where it becomes the document title", () => {
		const titled = renderTextEmail({
			subject: "</title><script>alert(1)</script>",
			text: "Body",
		});

		expect(titled).not.toMatch(/<script\b/i);
		expect(titled).toContain(
			"<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>",
		);
	});
});

describe("sampleVariableValues", () => {
	it("fills every variable, so a preview never shows a raw placeholder", () => {
		for (const key of NOTICE_VARIABLE_KEYS) {
			expect(sample[key]).toBeTruthy();
		}
	});

	it("lets a real value be written over a stand-in", () => {
		expect(
			sampleVariableValues(BROADCAST_VARIABLES, { wp_name: "Harbor Water" })
				.wp_name,
		).toBe("Harbor Water");
	});
});

describe("platform defaults", () => {
	it("has subject and body for all four notice types", () => {
		for (const noticeType of NOTICE_TYPES) {
			const copy = platformDefaultTemplate(noticeType);

			expect(copy.subject.trim()).not.toBe("");
			expect(copy.body.trim()).not.toBe("");
		}
	});

	it("uses only supported placeholders, so a default never sends a raw one", () => {
		for (const noticeType of NOTICE_TYPES) {
			const copy = platformDefaultTemplate(noticeType);

			expect(templateTextProblems(copy.subject, allKeys)).toEqual([]);
			expect(templateTextProblems(copy.body, allKeys)).toEqual([]);
		}
	});

	it("fits the field limits it will be edited in", () => {
		for (const noticeType of NOTICE_TYPES) {
			const copy = platformDefaultTemplate(noticeType);

			expect(copy.subject.length).toBeLessThanOrEqual(
				NOTICE_FIELD_LIMITS.subject,
			);
			expect(copy.body.length).toBeLessThanOrEqual(NOTICE_FIELD_LIMITS.body);
		}
	});
});

describe("upsertNoticeTemplateInput", () => {
	const valid = {
		noticeType: "reminder" as const,
		subject: "Due {{due_date}}",
		body: "Hello {{customer_name}}, BIN {{bin}}.",
	};

	it("accepts all six variables", () => {
		expect(upsertNoticeTemplateInput.safeParse(valid).success).toBe(true);
	});

	it("rejects a notice type that is not one of the four", () => {
		expect(
			upsertNoticeTemplateInput.safeParse({
				...valid,
				noticeType: "general_info",
			}).success,
		).toBe(false);
	});

	it("rejects a blank subject or body", () => {
		expect(
			upsertNoticeTemplateInput.safeParse({ ...valid, subject: "   " }).success,
		).toBe(false);
		expect(
			upsertNoticeTemplateInput.safeParse({ ...valid, body: "" }).success,
		).toBe(false);
	});

	it("rejects an unknown placeholder rather than saving text that sends one", () => {
		const result = upsertNoticeTemplateInput.safeParse({
			...valid,
			body: "Hello {{custmer_name}}",
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("{{custmer_name}}");
	});

	it("rejects a body past the length limit", () => {
		expect(
			upsertNoticeTemplateInput.safeParse({
				...valid,
				body: "x".repeat(NOTICE_FIELD_LIMITS.body + 1),
			}).success,
		).toBe(false);
	});

	it("has no way to send is_enabled or a tenant", () => {
		const parsed = upsertNoticeTemplateInput.parse({
			...valid,
			isEnabled: false,
			waterPurveyorId: "11111111-1111-4111-8111-111111111111",
		});

		expect(parsed).toEqual({
			noticeType: "reminder",
			subject: valid.subject,
			body: "Hello {{customer_name}}, BIN {{bin}}.",
		});
	});
});

describe("sendGeneralInfoBroadcastInput", () => {
	const valid = {
		subject: "News from {{wp_name}}",
		body: "Hello {{customer_name}}, here is our update.",
		recipientFilter: "all_customers" as const,
	};

	it("accepts the two recipient-scoped variables", () => {
		expect(sendGeneralInfoBroadcastInput.safeParse(valid).success).toBe(true);
	});

	it.each(["bfa_type", "bin", "service_address", "due_date"])(
		"refuses {{%s}}, which has no single value for a customer",
		(key) => {
			const result = sendGeneralInfoBroadcastInput.safeParse({
				...valid,
				body: `Your assembly {{${key}}} is due.`,
			});

			expect(result.success).toBe(false);
			expect(result.error?.issues[0]?.message).toContain("several");
		},
	);

	it("refuses an asset variable in the subject as well as the body", () => {
		expect(
			sendGeneralInfoBroadcastInput.safeParse({
				...valid,
				subject: "About {{bin}}",
			}).success,
		).toBe(false);
	});

	it("rejects a recipient filter that is not one of the three", () => {
		expect(
			sendGeneralInfoBroadcastInput.safeParse({
				...valid,
				recipientFilter: "everyone",
			}).success,
		).toBe(false);
	});

	it("rejects an empty subject or body", () => {
		expect(
			sendGeneralInfoBroadcastInput.safeParse({ ...valid, subject: " " })
				.success,
		).toBe(false);
		expect(
			sendGeneralInfoBroadcastInput.safeParse({ ...valid, body: "\n" }).success,
		).toBe(false);
	});
});
