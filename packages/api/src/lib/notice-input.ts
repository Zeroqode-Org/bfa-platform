import { z } from "zod";

import { NOTICE_TYPES } from "./notice-defaults";
import { NOTICE_FIELD_LIMITS } from "./notice-field-limits";
import { BROADCAST_RECIPIENT_FILTERS } from "./notice-recipients";
import {
	AUTOMATED_NOTICE_VARIABLES,
	BROADCAST_VARIABLES,
	type NoticeVariableKey,
	templateTextError,
	variableKeys,
} from "./notice-variables";

/**
 * Input shapes for the notices procedures.
 *
 * They live here rather than inline in the router so the validation rules can
 * be exercised without a database connection — `routers/notices.ts` imports
 * `@bfa-platform/db`, and importing that to assert that a broadcast may not use
 * `{{bin}}` would make a pure rule need a Postgres.
 *
 * `water_purveyor_id` is deliberately absent from every shape below. The
 * caller's tenant comes from their own profile in `wpProcedure`; a client that
 * sends one is sending a field the server does not read.
 */

export { NOTICE_FIELD_LIMITS };

/**
 * Subject or body, trimmed, non-empty, and using only the placeholders this
 * composer can actually resolve.
 *
 * The placeholder check is validation rather than something the renderer papers
 * over. `renderTemplate` leaves anything it cannot resolve visible on purpose,
 * so without this a typo would be saved and later mailed to a customer as
 * `{{custmer_name}}` — and an asset variable in a broadcast would be mailed to
 * somebody with three assemblies as `{{bin}}`, because there is no single BIN
 * to put there. Both are refused at the point they are written instead.
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
const broadcastKeys = variableKeys(BROADCAST_VARIABLES);

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
 * A general-info broadcast being sent.
 *
 * Only the two recipient-scoped variables are accepted. A customer may own
 * several assemblies, so `{{bin}}`, `{{bfa_type}}`, `{{service_address}}` and
 * `{{due_date}}` have no single value for a recipient — using one here is a
 * validation error with its own sentence rather than a silent blank.
 */
export const sendGeneralInfoBroadcastInput = z.object({
	subject: templateText("subject", "Subject", broadcastKeys),
	body: templateText("body", "Message", broadcastKeys),
	recipientFilter: z.enum(BROADCAST_RECIPIENT_FILTERS),
});

export type SendGeneralInfoBroadcastInput = z.infer<
	typeof sendGeneralInfoBroadcastInput
>;
