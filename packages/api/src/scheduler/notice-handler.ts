/**
 * The handler behind all four notice stages.
 *
 * One function, not four. The stages differ in exactly three ways — which
 * `notice_templates` row is used, whether the certifier list is appended, and
 * which stage is scheduled next — and all three are lookups. Four handlers
 * would be four copies of the tenancy, flag, recipient and rendering rules, and
 * the failure mode of that is a late notice that checks something the reminder
 * does not.
 *
 * Everything that decides what is sent, and to whom, is resolved **at send
 * time** from the asset's current state. Nothing is read from the job row except
 * which asset and which stage: a job queued two months ago must not carry a
 * customer id, because by the time it runs the occupant may have changed, and
 * mailing a former occupant a notice about somebody else's assembly is the exact
 * mistake the asset-centric data model exists to prevent (PRD § 5).
 *
 * The order of the checks below is load-bearing:
 *
 * 1. **The asset**, scoped to the job's purveyor. A job whose asset is gone or
 *    has moved tenant is cancelled, not failed.
 * 2. **The feature flag**, read now rather than trusted from scheduling time. A
 *    purveyor whose `automated_notices` was switched off after this job was
 *    queued gets no mail, and the job is `cancelled` — switching a paid add-on
 *    off is not a delivery failure and must not be retried as one.
 * 3. **The recipient**, through the asset's *current* customer, scoped to the
 *    asset's own purveyor. Missing or suspended means hold: no send, and the
 *    chain does not advance.
 * 4. **The text**, from the purveyor's own template row or the platform default.
 * 5. **The send**, claimed with `sent_at` first so a crash cannot duplicate it.
 * 6. **The successor**, scheduled in the same transaction that completes this
 *    job — and only if this job is still `running`, so a chain a passing test
 *    ended does not restart itself.
 */

import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	certifiers,
	customers,
	noticeTemplates,
	profiles,
	waterPurveyors,
	wpCertifierAuthorizations,
	wpFeatureFlags,
} from "@bfa-platform/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { sendEmail } from "../lib/email";
import { renderTextEmail } from "../lib/email-layout";
import {
	certifierListText,
	type NoticeType,
	platformDefaultTemplate,
} from "../lib/notice-defaults";
import { nextNoticeStage, noticeRunAt } from "../lib/notice-schedule";
import {
	AUTOMATED_NOTICE_VARIABLES,
	type NoticeVariableValues,
	renderTemplate,
	variableKeys,
} from "../lib/notice-variables";
import { RECIPIENT_HOLD_MS } from "./config";
import {
	cancelRunningJob,
	claimJobSend,
	completeRunningJob,
	holdRunningJob,
	releaseJobSend,
	type ScheduledJob,
	scheduleNoticeJob,
} from "./jobs";
import { logSchedulerEvent } from "./logging";
import { CANCEL_REASONS, HOLD_REASONS } from "./notice-chain";

/**
 * What one run of a notice job did.
 *
 * `held` and `cancelled` are both "no mail went out" and are deliberately
 * different results: a hold is temporary and keeps the row `pending`, a
 * cancellation is final. `superseded` means the job was withdrawn while this
 * handler was inside it.
 *
 * A thrown error is the fourth outcome and is not in this union — the loop
 * catches it and applies the retry policy, so a handler never decides its own
 * backoff.
 */
export type NoticeJobOutcome =
	| {
			kind: "sent";
			stage: NoticeType;
			customerId: string;
			nextStage: NoticeType | null;
	  }
	| { kind: "held"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "superseded" };

/** The variables an automated notice may use. A closed list, from the registry. */
const ALLOWED_VARIABLES = variableKeys(AUTOMATED_NOTICE_VARIABLES);

export async function runNoticeJob(
	job: ScheduledJob,
	stage: NoticeType,
	{ now = new Date() }: { now?: Date } = {},
): Promise<NoticeJobOutcome> {
	if (!job.bfaAssetId) {
		return cancel(
			job,
			stage,
			"A notice job with no assembly on it cannot be sent.",
		);
	}

	// Tenancy first, and from the asset's own row. `scheduled_jobs` carries a
	// `water_purveyor_id` and the asset carries one too; if they ever disagree —
	// a restore, a corrected row — the job is not this purveyor's to run.
	const [asset] = await db
		.select({
			id: bfaAssets.id,
			waterPurveyorId: bfaAssets.waterPurveyorId,
			bin: bfaAssets.bin,
			bfaType: bfaAssets.bfaType,
			serviceAddress: bfaAssets.serviceAddress,
			annualTestDate: bfaAssets.annualTestDate,
			currentCustomerId: bfaAssets.currentCustomerId,
		})
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, job.bfaAssetId),
				eq(bfaAssets.waterPurveyorId, job.waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset) return cancel(job, stage, CANCEL_REASONS.assetGone);

	if (!asset.annualTestDate) {
		return cancel(job, stage, CANCEL_REASONS.noAnnualTestDate);
	}

	if (!(await automatedNoticesEnabled(asset.waterPurveyorId))) {
		return cancel(job, stage, CANCEL_REASONS.featureDisabled);
	}

	const recipient = await resolveRecipient(asset);

	if ("hold" in recipient) {
		return hold(job, stage, recipient.hold, now);
	}

	const wpName = await purveyorName(asset.waterPurveyorId);
	const template = await resolveTemplate(asset.waterPurveyorId, stage);

	const values: NoticeVariableValues = {
		customer_name: recipient.customer.name,
		wp_name: wpName,
		bfa_type: asset.bfaType,
		bin: asset.bin,
		service_address: asset.serviceAddress,
		due_date: asset.annualTestDate,
	};

	const subject = renderTemplate(template.subject, values, ALLOWED_VARIABLES);
	const body = renderTemplate(template.body, values, ALLOWED_VARIABLES);

	// The reminder, and only the reminder, carries the list of testers. A late
	// notice is a compliance escalation, not an offer of help, and the customer
	// already had the list two months earlier.
	const certifierBlock =
		stage === "reminder"
			? certifierListText(await activeCertifiersFor(asset.waterPurveyorId))
			: null;

	const text = certifierBlock ? `${body}\n\n${certifierBlock}` : body;

	// Claimed before the send, never after — see `claimJobSend`. Losing this
	// statement means the mail is already out (or going out in another process),
	// so the send is skipped and the chain still advances.
	const ownsSend = await claimJobSend({ jobId: job.id, at: now });

	if (ownsSend) {
		try {
			await sendEmail(
				{
					to: recipient.customer.email,
					subject,
					// Escaped by `templateToHtml` inside `renderTextEmail`, then wrapped
					// in the one shared shell. No HTML template, no second layout.
					html: renderTextEmail({ subject, text }),
					tags: [
						{ name: "type", value: stage },
						{ name: "wp_id", value: asset.waterPurveyorId },
						{ name: "asset_id", value: asset.id },
					],
				},
				{
					event: `notice_${stage}`,
					recipientId: recipient.customer.id,
					wpId: asset.waterPurveyorId,
					assetId: asset.id,
				},
			);
		} catch (error) {
			// The provider refused, so nothing was accepted and the claim is given
			// back. The loop's retry policy takes it from here.
			await releaseJobSend({ jobId: job.id });
			throw error;
		}
	}

	const successor = nextNoticeStage(stage);

	// One transaction for the two writes that have to agree: this job is done,
	// and the next one exists. Completing without scheduling would silently end
	// the escalation; scheduling without completing would leave this stage
	// claimable again.
	const finished = await db.transaction(async (tx) => {
		const completed = await completeRunningJob({ executor: tx, jobId: job.id });

		if (!completed) return null;

		if (successor && asset.annualTestDate) {
			await scheduleNoticeJob({
				executor: tx,
				assetId: asset.id,
				waterPurveyorId: asset.waterPurveyorId,
				stage: successor,
				runAt: noticeRunAt(asset.annualTestDate, successor),
			});
		}

		return completed;
	});

	if (!finished) {
		logSchedulerEvent("scheduler_job_superseded", {
			jobId: job.id,
			jobType: stage,
			assetId: asset.id,
			waterPurveyorId: asset.waterPurveyorId,
			extra: {
				reason:
					"The job was cancelled while it was running; no successor was scheduled.",
				mail_sent: ownsSend,
			},
		});

		return { kind: "superseded" };
	}

	logSchedulerEvent("scheduler_job_completed", {
		jobId: job.id,
		jobType: stage,
		assetId: asset.id,
		waterPurveyorId: asset.waterPurveyorId,
		customerId: recipient.customer.id,
		extra: {
			// False on a retry that found the mail already claimed — the job
			// finished, but this pass sent nothing.
			mail_sent: ownsSend,
			template_source: template.source,
			certifier_count: certifierBlock
				? certifierBlock.split("\n").length - 1
				: 0,
			next_stage: successor,
			next_run_at:
				successor && asset.annualTestDate
					? noticeRunAt(asset.annualTestDate, successor).toISOString()
					: null,
		},
	});

	return {
		kind: "sent",
		stage,
		customerId: recipient.customer.id,
		nextStage: successor,
	};
}

/**
 * Whether this purveyor has the `automated_notices` add-on switched on.
 *
 * A missing row is off. Automated notices are a paid add-on the Super-Admin
 * enables per purveyor (PRD § 9), so the absence of a flag is the default state
 * of every new tenant and must never be read as permission to start mailing
 * their customers.
 */
async function automatedNoticesEnabled(
	waterPurveyorId: string,
): Promise<boolean> {
	const [flag] = await db
		.select({ isEnabled: wpFeatureFlags.isEnabled })
		.from(wpFeatureFlags)
		.where(
			and(
				eq(wpFeatureFlags.waterPurveyorId, waterPurveyorId),
				eq(wpFeatureFlags.feature, "automated_notices"),
			),
		)
		.limit(1);

	return flag?.isEnabled === true;
}

type RecipientResult =
	| { customer: { id: string; name: string; email: string } }
	| { hold: string };

/**
 * Who this notice goes to: the customer *currently* attached to the asset.
 *
 * Scoped to the asset's own purveyor as well as by id. `current_customer_id` is
 * a foreign key and nothing in it says the customer shares the asset's tenant;
 * `assignCustomer` refuses to point one across, but a row written before that
 * rule or restored from a backup is not bound by it, and a notice is the one
 * place a mispointed row would be mailed to the wrong company's customer.
 *
 * Suspension holds the asset's whole pipeline rather than skipping one email
 * (PRD § 9). The stage stays pending and the chain does not advance, so
 * nothing later in the escalation is consumed by a notice that was never sent.
 */
async function resolveRecipient(asset: {
	waterPurveyorId: string;
	currentCustomerId: string | null;
}): Promise<RecipientResult> {
	if (!asset.currentCustomerId) return { hold: HOLD_REASONS.noCustomer };

	const [customer] = await db
		.select({
			id: customers.id,
			name: customers.name,
			email: customers.email,
			status: customers.status,
		})
		.from(customers)
		.where(
			and(
				eq(customers.id, asset.currentCustomerId),
				eq(customers.waterPurveyorId, asset.waterPurveyorId),
			),
		)
		.limit(1);

	if (!customer) return { hold: HOLD_REASONS.noCustomer };
	if (customer.status === "suspended") {
		return { hold: HOLD_REASONS.suspendedCustomer };
	}
	if (!customer.email.trim()) return { hold: HOLD_REASONS.noEmail };

	return {
		customer: { id: customer.id, name: customer.name, email: customer.email },
	};
}

/**
 * The text for this stage: the purveyor's row where they wrote one, the
 * platform's where they did not.
 *
 * Column by column, not row by row. `subject` and `body` are both nullable, and
 * half a template saved is not a reason to send half an email — the same rule
 * `listNoticeTemplates` applies when it renders the editor, so what a purveyor
 * previews is what a customer receives.
 *
 * `is_enabled` is deliberately not read. Whether a purveyor sends automated
 * notices at all is `wp_feature_flags.automated_notices`; a per-stage switch is
 * a control with undefined behaviour until what disabling a middle step means
 * for the escalation chain is answered, and reading the column here would be
 * building it by accident.
 */
async function resolveTemplate(
	waterPurveyorId: string,
	stage: NoticeType,
): Promise<{ subject: string; body: string; source: "purveyor" | "platform" }> {
	const [row] = await db
		.select({
			subject: noticeTemplates.subject,
			body: noticeTemplates.body,
		})
		.from(noticeTemplates)
		.where(
			and(
				eq(noticeTemplates.waterPurveyorId, waterPurveyorId),
				eq(noticeTemplates.noticeType, stage),
			),
		)
		.limit(1);

	const fallback = platformDefaultTemplate(stage);
	const subject = row?.subject?.trim() ? row.subject : null;
	const body = row?.body?.trim() ? row.body : null;

	return {
		subject: subject ?? fallback.subject,
		body: body ?? fallback.body,
		source: subject && body ? "purveyor" : "platform",
	};
}

/**
 * The testers a customer of this purveyor can actually call.
 *
 * Both columns, and they mean different things. `authorization_status = 'active'`
 * is the purveyor's own relationship with the tester; `certifiers.status =
 * 'active'` is whether that tester has platform access at all. A certifier
 * revoked by this purveyor still works for others, and a blocked certifier
 * works for nobody — either one is a name that must not appear in this email.
 *
 * Resolved at send time, never cached and never stored on the job: a certifier
 * blocked yesterday must not appear in today's reminder.
 */
async function activeCertifiersFor(waterPurveyorId: string) {
	return (
		db
			.select({
				fullName: profiles.fullName,
				company: certifiers.company,
				idNumber: certifiers.idNumber,
			})
			.from(certifiers)
			.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
			.innerJoin(
				wpCertifierAuthorizations,
				eq(wpCertifierAuthorizations.certifierId, certifiers.id),
			)
			.where(
				and(
					eq(wpCertifierAuthorizations.waterPurveyorId, waterPurveyorId),
					eq(wpCertifierAuthorizations.authorizationStatus, "active"),
					eq(certifiers.status, "active"),
				),
			)
			// `id` breaks the tie so two testers with the same name keep a stable
			// order between one customer's email and the next.
			.orderBy(asc(profiles.fullName), asc(certifiers.id))
	);
}

/** The purveyor's own name, for `{{wp_name}}`. */
async function purveyorName(waterPurveyorId: string): Promise<string> {
	const [row] = await db
		.select({ companyName: waterPurveyors.companyName })
		.from(waterPurveyors)
		.where(eq(waterPurveyors.id, waterPurveyorId))
		.limit(1);

	return row?.companyName ?? "";
}

async function cancel(
	job: ScheduledJob,
	stage: NoticeType,
	reason: string,
): Promise<NoticeJobOutcome> {
	const cancelled = await cancelRunningJob({ jobId: job.id, reason });

	if (!cancelled) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_cancelled", {
		jobId: job.id,
		jobType: stage,
		assetId: job.bfaAssetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: { reason, trigger: "job_execution" },
	});

	return { kind: "cancelled", reason };
}

async function hold(
	job: ScheduledJob,
	stage: NoticeType,
	reason: string,
	now: Date,
): Promise<NoticeJobOutcome> {
	const runAt = new Date(now.getTime() + RECIPIENT_HOLD_MS);
	const held = await holdRunningJob({ jobId: job.id, reason, runAt });

	if (!held) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_held", {
		jobId: job.id,
		jobType: stage,
		assetId: job.bfaAssetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: { reason, held_until: runAt.toISOString() },
	});

	return { kind: "held", reason };
}
