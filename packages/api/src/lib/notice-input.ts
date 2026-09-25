import { z } from "zod";

import { NOTICE_TYPES } from "./notice-defaults";
import { NOTICE_FIELD_LIMITS } from "./notice-field-limits";
import { BROADCAST_RECIPIENT_FILTERS } from "./notice-recipients";
import {
	AUTOMATED_NOTICE_VARIABLES,
	type NoticeVariableKey,
	templateTextError,
	variableKeys,
} from "./notice-variables";

/**
 * Input shapes for the notices procedures.
 *
 * They live here rather than inline in the router so the validation rules can
 * be exercised without a database connection — `routers/notices.ts` imports
 * `@bfa-platform/db`, and importing that to assert that a template may not use
 * `{{custmer_name}}` would make a pure rule need a Postgres.
 *
 * `water_purveyor_id` is deliberately absent from every shape below. The
 * caller's tenant comes from their own profile in `wpProcedure`; a client that
 * sends one is sending a field the server does not read.
 */

export { NOTICE_FIELD_LIMITS };

/**
 * Notice-template subject or body, trimmed, non-empty, and using only the
 * placeholders the automated notices can actually resolve.
 *
 * The placeholder check is validation rather than something the renderer papers
 * over. `renderTemplate` leaves anything it cannot resolve visible on purpose,
 * so without this a typo would be saved and later mailed to a customer as
 * `{{custmer_name}}`. It is refused at the point it is written instead.
 */
function templateText(
	field: "subject" | "body",
	label: string,
	allowed: readonly NoticeVariableKey[],
) {
	return z
		.string()
		.trim()
		.min(1, `${label} is required`)
		.max(NOTICE_FIELD_LIMITS[field])
		.superRefine((value, ctx) => {
			const message = templateTextError(value, allowed);

			if (message) ctx.addIssue({ code: "custom", message });
		});
}

const automatedKeys = variableKeys(AUTOMATED_NOTICE_VARIABLES);

/**
 * Broadcast subject or body: trimmed, non-empty, within the shared limit — and
 * nothing else.
 *
 * A broadcast is literal text. There is no substitution on this path, so there
 * is no placeholder syntax to check either: `{{customer_name}}` typed into a
 * broadcast is sent as those seventeen characters, exactly like any other
 * braces somebody writes.
 */
function literalText(field: "subject" | "body", label: string) {
	return z
		.string()
		.trim()
		.min(1, `${label} is required`)
		.max(NOTICE_FIELD_LIMITS[field]);
}

/**
 * One notice template being saved.
 *
 * `isEnabled` is not here and must not be added. Automated notices are switched
 * on a level up, per purveyor, by the Super-Admin through
 * `wp_feature_flags.automated_notices`; a per-type switch the WP controls is a
 * control with undefined behaviour until what disabling a middle step means for
 * the escalation chain is answered.
 */
export const upsertNoticeTemplateInput = z.object({
	noticeType: z.enum(NOTICE_TYPES),
	subject: templateText("subject", "Subject", automatedKeys),
	body: templateText("body", "Message", automatedKeys),
});

export type UpsertNoticeTemplateInput = z.infer<
	typeof upsertNoticeTemplateInput
>;

export const broadcastRecipientFilterInput = z.object({
	recipientFilter: z.enum(BROADCAST_RECIPIENT_FILTERS),
});

/**
 * A general-info broadcast being sent: one literal subject and body, the same
 * for every recipient (PRD § 6.10 — no personalisation), and a named audience.
 */
export const sendGeneralInfoBroadcastInput = z.object({
	subject: literalText("subject", "Subject"),
	body: literalText("body", "Message"),
	recipientFilter: z.enum(BROADCAST_RECIPIENT_FILTERS),
});

export type SendGeneralInfoBroadcastInput = z.infer<
	typeof sendGeneralInfoBroadcastInput
>;
