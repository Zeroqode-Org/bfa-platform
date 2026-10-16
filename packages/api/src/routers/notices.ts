import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	customers,
	noticeTemplates,
	noticeTypeValues,
	waterPurveyors,
} from "@bfa-platform/db/schema";
import { and, asc, eq, exists, sql } from "drizzle-orm";

import { router, TRPCError, wpProcedure } from "../index";
import { isPastDue } from "../lib/asset-status-sql";
import {
	type AuditActor,
	auditActor,
	auditActorFields,
} from "../lib/audit-actor";
import { sendEmail } from "../lib/email";
import { renderTextEmail } from "../lib/email-layout";
import {
	NOTICE_TYPE_LABELS,
	type NoticeType,
	platformDefaultTemplate,
} from "../lib/notice-defaults";
import {
	broadcastRecipientFilterInput,
	sendGeneralInfoBroadcastInput,
	upsertNoticeTemplateInput,
} from "../lib/notice-input";
import type { BroadcastRecipientFilter } from "../lib/notice-recipients";
import { sampleVariableValues } from "../lib/notice-variables";

/**
 * Only a WP Admin may change what this purveyor's customers are sent.
 *
 * Deliberately local to this router rather than a shared `wpAdminProcedure` in
 * `../index`, for the same reason `submitted-tests.ts` keeps its own editor
 * procedure: the SubAdmin/Employee split is an open question project-wide
 * (PRD § 10), and a shared procedure would read as a project-wide answer that
 * the next feature could inherit by accident.
 *
 * What was decided for *this* screen: all three WP roles read the templates and
 * the repair-company list, and only the Admin rewrites a template or sends a
 * broadcast. Both of those put words in the purveyor's name in front of every
 * customer they have, which is not clerk work — and this is the narrow,
 * reversible direction, because widening it later is one predicate while
 * narrowing it means taking access away from people who had it.
 */
const wpNoticeAuthorProcedure = wpProcedure.use(({ ctx, next }) => {
	if (ctx.caller.globalRole !== "wp_admin") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only a WP Admin can change notice text or send a broadcast",
		});
	}

	return next({ ctx });
});

/**
 * Notice text and the general-info broadcast, for one water purveyor.
 *
 * Two things share this screen and share nothing else. The four automated
 * notice templates are stored text that a future scheduler will send about one
 * assembly; the general-info broadcast is a one-off message composed and sent
 * now, to a filtered set of customers, and it deliberately does not touch
 * `notice_templates` — it is not a template, there is no history, there is no
 * scheduler involved and there is no substitution: what the Admin types is
 * what every recipient reads.
 *
 * `is_enabled` is read by nothing here and written by nothing here. Automated
 * notices are switched on per purveyor by the Super-Admin through
 * `wp_feature_flags.automated_notices`; a per-type switch is a control with
 * undefined behaviour until what disabling a middle step means for the
 * escalation chain is answered.
 *
 * Every statement below reads through the privileged Drizzle connection, which
 * bypasses RLS. That makes `wpProcedure` plus the `water_purveyor_id` predicate
 * on each query the authorization boundary in the app, and the policies in
 * `0010_notice_template_policies` the same boundary for anything that reaches
 * the table through PostgREST. Neither is a substitute for the other; the RLS
 * suite in `packages/db/src/notice-templates-rls.test.ts` covers the second.
 */
export const noticesRouter = router({
	/**
	 * All four notice types for the caller's purveyor: the saved row where there
	 * is one, the platform default where there is not.
	 *
	 * Always four entries, in escalation order, whatever the table holds. A
	 * missing row is not an absence the screen has to handle — it means the
	 * purveyor has not customized that notice, and the text that would be sent
	 * is the platform's. `isCustomized` is what distinguishes the two, so the
	 * editor can say which it is showing without a second shape to render.
	 */
	listNoticeTemplates: wpProcedure.query(async ({ ctx }) => {
		const saved = await db
			.select({
				id: noticeTemplates.id,
				noticeType: noticeTemplates.noticeType,
				subject: noticeTemplates.subject,
				body: noticeTemplates.body,
				updatedAt: noticeTemplates.updatedAt,
			})
			.from(noticeTemplates)
			.where(eq(noticeTemplates.waterPurveyorId, ctx.caller.waterPurveyorId));

		const byType = new Map(saved.map((row) => [row.noticeType, row]));

		// Driven off the database enum rather than a list retyped here, so a fifth
		// notice type is a migration and an entry in `PLATFORM_DEFAULT_NOTICE_
		// TEMPLATES` — the indexing below stops compiling until it has one.
		return noticeTypeValues.map((noticeType) => {
			const row = byType.get(noticeType);
			const fallback = platformDefaultTemplate(noticeType);

			// A row with a null or blank column is still a fallback for that column.
			// `subject` and `body` are nullable, and half a template saved is not a
			// reason to send half an email.
			const subject = row?.subject?.trim() ? row.subject : null;
			const body = row?.body?.trim() ? row.body : null;

			return {
				noticeType,
				label: NOTICE_TYPE_LABELS[noticeType],
				subject: subject ?? fallback.subject,
				body: body ?? fallback.body,
				/** False means: this is the platform's text, not this purveyor's. */
				isCustomized: Boolean(subject && body),
				defaultSubject: fallback.subject,
				defaultBody: fallback.body,
				updatedAt: row?.updatedAt ?? null,
			};
		});
	}),

	/**
	 * Sample values for the preview: the registry's stand-ins, with the
	 * purveyor's real name written over `{{wp_name}}`.
	 *
	 * The name is the one value that is not a guess, and a preview showing
	 * "Your Water Purveyor" where the customer will read the real name is a
	 * worse preview than it needs to be. Everything else stays recognisably
	 * fake — this is a preview of a template, not of one customer's mail.
	 */
	getNoticePreviewSample: wpProcedure.query(async ({ ctx }) => {
		return {
			values: sampleVariableValues(undefined, {
				wp_name: await purveyorName(ctx.caller.waterPurveyorId),
			}),
		};
	}),

	/**
	 * Writes one notice template for the caller's purveyor. WP Admin only.
	 *
	 * Upsert, not update: the first save for a type creates the row, and every
	 * later one rewrites it. The conflict target is the
	 * `(water_purveyor_id, notice_type)` unique constraint, which is what makes
	 * "one template per type per purveyor" a database fact rather than a race
	 * two simultaneous saves could lose.
	 *
	 * The tenant comes from `ctx.caller` and nowhere else. There is no
	 * `waterPurveyorId` on the input, so a client has no field in which to ask
	 * for another purveyor's — and the `where` on the update half pins the
	 * tenant again, so the statement cannot reach a row outside it even if the
	 * conflict target ever changed.
	 *
	 * A save that changes nothing writes nothing. See {@link unchangedTemplate}.
	 */
	upsertNoticeTemplate: wpNoticeAuthorProcedure
		.input(upsertNoticeTemplateInput)
		.mutation(async ({ ctx, input }) => {
			const unchanged = await unchangedTemplate(
				ctx.caller.waterPurveyorId,
				input,
			);

			if (unchanged) {
				return {
					...unchanged,
					label: NOTICE_TYPE_LABELS[unchanged.noticeType],
					isCustomized: true,
				};
			}

			const [row] = await db
				.insert(noticeTemplates)
				.values({
					waterPurveyorId: ctx.caller.waterPurveyorId,
					noticeType: input.noticeType,
					subject: input.subject,
					body: input.body,
				})
				.onConflictDoUpdate({
					target: [noticeTemplates.waterPurveyorId, noticeTemplates.noticeType],
					set: {
						subject: input.subject,
						body: input.body,
						updatedAt: new Date(),
					},
					// `is_enabled` is absent from the set, and so is the tenant. The
					// predicate is belt and braces on the second: the conflict target
					// already includes `water_purveyor_id`, so the row being updated is
					// the caller's by construction.
					setWhere: eq(
						noticeTemplates.waterPurveyorId,
						ctx.caller.waterPurveyorId,
					),
				})
				.returning({
					id: noticeTemplates.id,
					noticeType: noticeTemplates.noticeType,
					subject: noticeTemplates.subject,
					body: noticeTemplates.body,
					updatedAt: noticeTemplates.updatedAt,
				});

			if (!row) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Notice template upsert returned no row",
				});
			}

			logNoticeEvent("notice_template_saved", {
				actor: auditActor(ctx),
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: {
					notice_type: row.noticeType,
					notice_template_id: row.id,
				},
			});

			return {
				...row,
				label: NOTICE_TYPE_LABELS[row.noticeType],
				isCustomized: true,
			};
		}),

	/**
	 * How many customers a recipient filter selects.
	 *
	 * The count is what the composer shows before anything is sent, so the
	 * person pressing Send knows how many people are about to read this. Same
	 * predicate as the send itself — {@link recipientsFor} is the only place the
	 * three audiences are defined — so the number cannot describe one set while
	 * the send addresses another.
	 */
	getBroadcastAudience: wpProcedure
		.input(broadcastRecipientFilterInput)
		.query(async ({ ctx, input }) => {
			const recipients = await recipientsFor(
				ctx.caller.waterPurveyorId,
				input.recipientFilter,
			);

			// A count, not a list: the composer needs to say how many people this
			// reaches, not show anybody's address on screen.
			return {
				recipientFilter: input.recipientFilter,
				recipientCount: recipients.length,
			};
		}),

	/**
	 * Sends one general-info broadcast. WP Admin only.
	 *
	 * Literal text, rendered once. PRD § 6.10 asks for no personalisation, so
	 * nothing here substitutes: `{{…}}` typed by hand is sent as written, and
	 * every recipient receives the identical subject and body. The body is still
	 * escaped by `renderTextEmail`, so markup typed into it arrives as text.
	 *
	 * Every send goes through `sendEmail`, which emits one structured line per
	 * attempt whether it succeeded or threw. Nothing here talks to a provider —
	 * the console driver works with no keys configured, which is what makes this
	 * path testable before a domain exists.
	 *
	 * A partial failure is a failure. If any required send throws, this refuses
	 * rather than reporting a broadcast that some customers never received; the
	 * error names how many of each, and the per-attempt log lines say which.
	 * Nothing is retried automatically — a resend is the Admin's decision,
	 * because the successful recipients would receive the message twice.
	 */
	sendGeneralInfoBroadcast: wpNoticeAuthorProcedure
		.input(sendGeneralInfoBroadcastInput)
		.mutation(async ({ ctx, input }) => {
			const recipients = await recipientsFor(
				ctx.caller.waterPurveyorId,
				input.recipientFilter,
			);

			logNoticeEvent("general_info_broadcast_started", {
				actor: auditActor(ctx),
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: {
					recipient_filter: input.recipientFilter,
					recipient_count: recipients.length,
				},
			});

			if (recipients.length === 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"That audience has no customers in it — nothing would be sent.",
				});
			}

			// Escaped by `templateToHtml`, then wrapped in the shared shell. The same
			// for everyone, so it is built once rather than per recipient.
			const html = renderTextEmail({
				subject: input.subject,
				text: input.body,
			});
			const failures: string[] = [];
			let sent = 0;

			for (const recipient of recipients) {
				try {
					await sendEmail(
						{
							to: recipient.email,
							subject: input.subject,
							html,
							tags: [
								{ name: "type", value: "general_info_broadcast" },
								{ name: "recipient_filter", value: input.recipientFilter },
								{ name: "wp_id", value: ctx.caller.waterPurveyorId },
							],
						},
						{
							event: "general_info_broadcast",
							actor: auditActor(ctx),
							recipientId: recipient.id,
							wpId: ctx.caller.waterPurveyorId,
						},
					);
					sent += 1;
				} catch {
					// The message and the stack are already on the `sendEmail` log line
					// for this attempt. What is kept here is which customer it was, so
					// the failure the Admin sees can be counted and traced.
					failures.push(recipient.id);
				}
			}

			logNoticeEvent("general_info_broadcast_finished", {
				actor: auditActor(ctx),
				waterPurveyorId: ctx.caller.waterPurveyorId,
				extra: {
					recipient_filter: input.recipientFilter,
					recipient_count: recipients.length,
					sent_count: sent,
					failed_count: failures.length,
					failed_customer_ids: failures,
					status: failures.length === 0 ? "sent" : "partial_failure",
				},
			});

			if (failures.length > 0) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Broadcast incomplete: ${sent} of ${recipients.length} messages were sent and ${failures.length} failed. Check the delivery log before resending — the customers who did receive it would get it twice.`,
				});
			}

			return {
				recipientFilter: input.recipientFilter,
				recipientCount: recipients.length,
				sentCount: sent,
			};
		}),
});

/**
 * The stored row, when a save would write exactly what it already holds —
 * otherwise `null`.
 *
 * Opening a template and pressing save without touching a field is not an
 * update, and writing one anyway would make two records lie. `updated_at` would
 * come to mean "when somebody last pressed save" rather than when the text last
 * changed, and the audit trail would carry a `notice_template_saved` line for a
 * modification that never happened — the one thing an audit trail must not do.
 * The same rule `updateRepairCompany` follows.
 *
 * A *missing* row is never unchanged, even when the text submitted is the
 * platform default verbatim. Writing it is what turns "this purveyor uses the
 * platform's words" into "this purveyor chose these words", and those are
 * different facts: the platform copy can be revised, and a purveyor who adopted
 * it deliberately should not be revised with it.
 *
 * Scoped by tenant as well as type, like every other read here, so a foreign
 * row cannot be observed through the comparison either.
 */
async function unchangedTemplate(
	waterPurveyorId: string,
	input: { noticeType: NoticeType; subject: string; body: string },
) {
	const [existing] = await db
		.select({
			id: noticeTemplates.id,
			noticeType: noticeTemplates.noticeType,
			subject: noticeTemplates.subject,
			body: noticeTemplates.body,
			updatedAt: noticeTemplates.updatedAt,
		})
		.from(noticeTemplates)
		.where(
			and(
				eq(noticeTemplates.waterPurveyorId, waterPurveyorId),
				eq(noticeTemplates.noticeType, input.noticeType),
			),
		)
		.limit(1);

	if (!existing) return null;

	return existing.subject === input.subject && existing.body === input.body
		? existing
		: null;
}

/**
 * The purveyor's own name, for `{{wp_name}}` in the notice-template preview.
 *
 * Scoped by id to the caller's tenant, like everything else that reads through
 * the privileged connection. A purveyor with no row is not a case that should
 * arise — `wpProcedure` resolved the id off the caller's profile, which carries
 * a foreign key — so the empty string is a floor rather than a fallback, and it
 * leaves the placeholder visible instead of substituting a blank.
 */
async function purveyorName(waterPurveyorId: string): Promise<string> {
	const [row] = await db
		.select({ companyName: waterPurveyors.companyName })
		.from(waterPurveyors)
		.where(eq(waterPurveyors.id, waterPurveyorId))
		.limit(1);

	return row?.companyName ?? "";
}

type BroadcastRecipient = {
	id: string;
	email: string;
};

/**
 * The customers one recipient filter selects, A–Z, each appearing once.
 *
 * The only definition of the three audiences. Both the count the composer shows
 * and the loop that sends read it, so the number on screen and the set that is
 * written to cannot drift apart.
 *
 * Two decisions are baked into the shared predicate:
 *
 * **Suspended customers are excluded, from every filter.** `customers.status`
 * exists to hold a customer's notice pipeline, and a purveyor who suspended an
 * account has said they are not writing to them at the moment. The requirements
 * did not settle whether that covers general information as well as automated
 * notices; this is the safe direction, because the cost of the other one is
 * mail somebody has decided not to send. It is one predicate to reverse if the
 * client wants suspended customers included.
 *
 * **Each customer appears once.** `past_due_only` asks a question about
 * assemblies, and a customer with three past-due assemblies is still one person
 * with one inbox. `exists` answers it without producing a row per asset, so the
 * de-duplication is structural rather than a `distinct` somebody could drop.
 */
async function recipientsFor(
	waterPurveyorId: string,
	filter: BroadcastRecipientFilter,
): Promise<BroadcastRecipient[]> {
	const tenantAndActive = and(
		eq(customers.waterPurveyorId, waterPurveyorId),
		eq(customers.status, "active"),
	);

	const predicate =
		filter === "agricultural_only"
			? and(tenantAndActive, eq(customers.rateCategory, "agricultural"))
			: filter === "past_due_only"
				? and(
						tenantAndActive,
						exists(
							db
								.select({ one: sql`1` })
								.from(bfaAssets)
								.where(
									and(
										eq(bfaAssets.currentCustomerId, customers.id),
										// The asset's own tenant, again. `current_customer_id` is
										// a foreign key and nothing in it says the asset shares
										// the customer's purveyor, so without this clause a
										// mispointed asset in another tenant could decide that
										// this customer is past due.
										eq(bfaAssets.waterPurveyorId, waterPurveyorId),
										// As of today, from the date — not the stored column,
										// which only a scheduler tick moves.
										isPastDue(),
									),
								),
						),
					)
				: tenantAndActive;

	return (
		db
			.select({
				id: customers.id,
				email: customers.email,
			})
			.from(customers)
			.where(predicate)
			// `id` breaks the tie so two customers with the same name keep a stable
			// order between the count and the send.
			.orderBy(asc(customers.name), asc(customers.id))
	);
}

/**
 * One structured JSON line per sensitive action, in the same shape as
 * `repair_company_created` and `caller_resolved`. A string log would not be
 * greppable by tenant, which is the whole point of carrying `wp_id`.
 */
function logNoticeEvent(
	event: string,
	{
		actor,
		waterPurveyorId,
		extra,
	}: {
		actor: AuditActor;
		waterPurveyorId: string;
		extra?: Record<string, unknown>;
	},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			wp_id: waterPurveyorId,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
