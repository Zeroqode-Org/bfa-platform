/**
 * Workflow 3's failure notice: one email per submitted failing test, delivered
 * through the scheduler as a durable outbox.
 *
 * The mutation that makes a submitted test a linked fail queues one
 * `failure_notice` job — due immediately, in the same transaction as the write
 * that justifies it — and the scheduler's next tick sends it. Not sent inline
 * from the mutation, because an email is an external side effect the
 * transaction cannot take back, and the scheduler already owns the machinery
 * that makes a send survive crashes without duplicating: the frozen payload,
 * the provider idempotency key, retry with backoff, and startup recovery. A
 * rolled-back correction leaves no job behind; a crash mid-send is settled by
 * asking the provider again under the same key.
 *
 * The email and the fail list are separate clocks. The email goes out now;
 * the asset reaches the WP's fail list only after its failure has gone 30
 * days without a later submitted pass (PRD § 6.8). There is deliberately **no
 * stored fail-list state anywhere in this module**: the job is the pending
 * delivery of one email, nothing more. Fail-list membership — the 30 days
 * included — is computed from `test_submissions` history at read time
 * (`listFailingAssets` behind `dashboard.failList`), so an episode crosses
 * the boundary because time passed, not because anything was written. That
 * is also why the pre-declared `fail_list_check` job type stays unused:
 * there is nothing on day 30 for a job to do.
 *
 * Everything the email contains is resolved **at send time** from current
 * state, exactly as the escalation handler does it. The job carries only which
 * submission it answers:
 *
 * - the assembly, read through the submission's own link, tenant-checked;
 * - the recipient, the asset's *current* customer — suspended or missing
 *   holds the job rather than failing it;
 * - the repair companies, the purveyor's currently **active** ones, name and
 *   phone only — a company deactivated yesterday is not in today's email, and
 *   a repair company's email address never appears in a customer's inbox;
 * - the relevance check: a submitted *pass* filed after this fail (in
 *   submission-event order) cancels the job instead of sending, because a
 *   customer whose assembly has since passed must not be told to arrange
 *   repairs. The build plan's "passing re-test removes the asset" applies to
 *   the unsent notice too.
 *
 * Not gated on `automated_notices` — the failure notice is not an optional
 * paid add-on (build plan, Workflow 3: "Not gated"). If that decision flips,
 * it is one flag check at the top of {@link runFailureNoticeJob}.
 */

import { db } from "@bfa-platform/db";
import type { FrozenEmailPayload } from "@bfa-platform/db/schema";
import {
	bfaAssets,
	repairCompanies,
	testSubmissions,
	waterPurveyors,
} from "@bfa-platform/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

import { alphabetically } from "../lib/alphabetical-order";
import type { AuditActor } from "../lib/audit-actor";
import { type EmailDriver, resolveSenderIdentity } from "../lib/email";
import { renderTextEmail } from "../lib/email-layout";
import {
	failureNoticeText,
	repairCompanyListText,
} from "../lib/failure-notice-copy";
import { type DeliveryPassKind, settleJobDelivery } from "./delivery";
import {
	cancelFailureNoticeJobs,
	cancelRunningJob,
	completeRunningJob,
	type JobExecutor,
	type ScheduledJob,
	scheduleFailureNoticeJob,
} from "./jobs";
import { logSchedulerEvent } from "./logging";
import { resolveRecipient } from "./notice-handler";

/** Why a failure notice was withdrawn. Read by people in `last_error`. */
export const FAILURE_CANCEL_REASONS = {
	noSubmission: "A failure notice with no submission on it cannot be sent.",
	submissionGone:
		"The submitted test this notice answers no longer exists in this water purveyor.",
	notAFailingSubmission:
		"The submitted test this notice answers is no longer a submitted failing test.",
	notLinkedToAsset:
		"The submitted test this notice answers is not linked to an assembly.",
	assetGone: "The assembly is no longer registered to this water purveyor.",
	resolvedByLaterPass:
		"A passing test was submitted for this assembly after the failure, which resolves it.",
	correctedAway:
		"The submitted test was corrected and is no longer a failing test.",
} as const;

/**
 * Queues the failure notice for one submitted failing test, due now.
 *
 * Safe inside the caller's transaction, and the callers use that: a correction
 * that rolls back must not leave a job behind to mail its customer. Idempotent
 * at the database — the settled-submission index means a still-failing row
 * saved twice, or two clerks saving at once, cannot queue a second email for a
 * fail the customer was already told about (see `scheduleFailureNoticeJob`).
 *
 * Logs only when a row was actually created, the same no-op rule every
 * mutation follows.
 */
export async function scheduleFailureNotice({
	executor = db,
	submissionId,
	assetId,
	waterPurveyorId,
	actor = null,
	trigger,
	now = new Date(),
}: {
	executor?: JobExecutor;
	submissionId: string;
	/** For the log line only; the job itself carries the submission. */
	assetId: string;
	waterPurveyorId: string;
	actor?: AuditActor | null;
	trigger: string;
	now?: Date;
}): Promise<ScheduledJob | null> {
	const scheduled = await scheduleFailureNoticeJob({
		executor,
		submissionId,
		waterPurveyorId,
		runAt: now,
	});

	if (!scheduled) return null;

	logSchedulerEvent("scheduler_job_scheduled", {
		jobId: scheduled.id,
		jobType: scheduled.jobType,
		assetId,
		waterPurveyorId,
		actor,
		extra: {
			trigger,
			submission_id: submissionId,
			run_at: scheduled.runAt.toISOString(),
		},
	});

	return scheduled;
}

/**
 * Withdraws the unsent failure notice for a submission that stopped being a
 * submitted failing test — corrected to pass, or to no result at all.
 *
 * A notice already delivered is untouched: the email is a fact and its
 * `completed` row keeps saying so. What the correction changes is the future,
 * not the record.
 */
export async function cancelFailureNoticeForSubmission({
	executor = db,
	submissionId,
	assetId,
	waterPurveyorId,
	actor = null,
	trigger,
}: {
	executor?: JobExecutor;
	submissionId: string;
	assetId: string | null;
	waterPurveyorId: string;
	actor?: AuditActor | null;
	trigger: string;
}): Promise<void> {
	const cancelled = await cancelFailureNoticeJobs({
		executor,
		submissionId,
		reason: FAILURE_CANCEL_REASONS.correctedAway,
	});

	for (const job of cancelled) {
		logSchedulerEvent("scheduler_job_cancelled", {
			jobId: job.id,
			jobType: job.jobType,
			assetId,
			waterPurveyorId,
			actor,
			extra: {
				reason: FAILURE_CANCEL_REASONS.correctedAway,
				trigger,
				submission_id: submissionId,
			},
		});
	}
}

export type FailureNoticeOutcome =
	| {
			kind: "sent";
			providerMessageId: string;
			deliveryPass: DeliveryPassKind;
	  }
	| { kind: "held"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "delivery_unconfirmed"; reason: string }
	| { kind: "superseded" };

/**
 * The handler behind `failure_notice` jobs.
 *
 * Re-decides everything from current state on every pass, in this order:
 *
 * 1. **The submission**, scoped to the job's purveyor. Gone, no longer
 *    submitted, no longer a fail, or never linked to an assembly — cancelled,
 *    not failed: the system was told something, it did not break.
 * 2. **The assembly**, through the submission's own link and tenant-checked
 *    against the submission's purveyor. A link that crossed tenants is never
 *    mailed.
 * 3. **The relevance check**: a submitted pass filed after this fail (by
 *    `(created_at, id)` — submission-event order, never the certifier-typed
 *    `test_date`) cancels the notice. The same comparison the fail list makes.
 * 4. **The delivery**, through the shared settlement: recipient and repair
 *    companies resolved now, payload frozen once, sent under the job's own
 *    idempotency key, outcome recorded only from the provider's answer.
 *    A missing, suspended or email-less current customer holds the job.
 * 5. **Completion**, with no successor — a failure notice is one email, not a
 *    chain.
 *
 * Steps 1–3 run on every pass, including a retry that will replay a frozen
 * payload: a pass filed between two attempts still stops the send.
 */
export async function runFailureNoticeJob(
	job: ScheduledJob,
	{ now = new Date(), driver }: { now?: Date; driver?: EmailDriver } = {},
): Promise<FailureNoticeOutcome> {
	if (!job.testSubmissionId) {
		return cancel(job, null, FAILURE_CANCEL_REASONS.noSubmission);
	}

	// Tenancy first, and from the submission's own row: the job's purveyor and
	// the submission's must agree, or the job is not this purveyor's to run.
	const [submission] = await db
		.select({
			id: testSubmissions.id,
			bfaAssetId: testSubmissions.bfaAssetId,
			status: testSubmissions.status,
			testResult: testSubmissions.testResult,
			testDate: testSubmissions.testDate,
			createdAt: testSubmissions.createdAt,
		})
		.from(testSubmissions)
		.where(
			and(
				eq(testSubmissions.id, job.testSubmissionId),
				eq(testSubmissions.waterPurveyorId, job.waterPurveyorId),
			),
		)
		.limit(1);

	if (!submission) {
		return cancel(job, null, FAILURE_CANCEL_REASONS.submissionGone);
	}

	if (submission.status !== "submitted" || submission.testResult !== "fail") {
		return cancel(job, null, FAILURE_CANCEL_REASONS.notAFailingSubmission);
	}

	if (!submission.bfaAssetId) {
		return cancel(job, null, FAILURE_CANCEL_REASONS.notLinkedToAsset);
	}

	// The asset through the submission's link, tenant-checked. The foreign key
	// proves the asset exists, not that it belongs to the same purveyor.
	const [asset] = await db
		.select({
			id: bfaAssets.id,
			waterPurveyorId: bfaAssets.waterPurveyorId,
			bin: bfaAssets.bin,
			bfaType: bfaAssets.bfaType,
			serviceAddress: bfaAssets.serviceAddress,
			currentCustomerId: bfaAssets.currentCustomerId,
		})
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, submission.bfaAssetId),
				eq(bfaAssets.waterPurveyorId, job.waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset) return cancel(job, null, FAILURE_CANCEL_REASONS.assetGone);

	if (
		await passSubmittedAfter({
			assetId: asset.id,
			waterPurveyorId: asset.waterPurveyorId,
			failCreatedAt: submission.createdAt,
			failId: submission.id,
		})
	) {
		return cancel(job, asset.id, FAILURE_CANCEL_REASONS.resolvedByLaterPass);
	}

	const settlement = await settleJobDelivery<RenderedFailureNotice>({
		job,
		jobType: "failure_notice",
		emailEvent: "failure_notice",
		assetId: asset.id,
		waterPurveyorId: asset.waterPurveyorId,
		now,
		driver,
		render: async () => {
			const recipient = await resolveRecipient(asset);

			if ("hold" in recipient) return recipient;

			return renderFailureNotice(
				asset,
				recipient.customer,
				submission.testDate,
				driver,
			);
		},
	});

	if (settlement.kind !== "delivered") return settlement;

	// No successor and no chain, so completion is one conditional write: it
	// refuses a row a correction cancelled mid-send, and the delivery already
	// recorded stays on the record either way.
	const completed = await completeRunningJob({ jobId: job.id });

	if (!completed) {
		logSchedulerEvent("scheduler_job_superseded", {
			jobId: job.id,
			jobType: "failure_notice",
			assetId: asset.id,
			waterPurveyorId: asset.waterPurveyorId,
			extra: {
				reason: "The job was cancelled while it was running.",
				provider_message_id: settlement.providerMessageId,
			},
		});

		return { kind: "superseded" };
	}

	logSchedulerEvent("scheduler_job_completed", {
		jobId: job.id,
		jobType: "failure_notice",
		assetId: asset.id,
		waterPurveyorId: asset.waterPurveyorId,
		customerId: settlement.recipientId ?? settlement.rendered?.customerId,
		extra: {
			submission_id: submission.id,
			provider_message_id: settlement.providerMessageId,
			delivery_pass: settlement.pass,
			repair_company_count: settlement.rendered?.repairCompanyCount ?? null,
		},
	});

	return {
		kind: "sent",
		providerMessageId: settlement.providerMessageId,
		deliveryPass: settlement.pass,
	};
}

type RenderedFailureNotice = {
	payload: FrozenEmailPayload;
	customerId: string;
	repairCompanyCount: number;
};

/**
 * The failure email, rendered once and frozen. Fixed copy plus the
 * repair-company block; every value is escaped by `renderTextEmail`'s
 * `templateToHtml`, the one rendering path every automated message takes.
 */
async function renderFailureNotice(
	asset: {
		id: string;
		waterPurveyorId: string;
		bin: string;
		bfaType: string;
		serviceAddress: string;
	},
	customer: { id: string; name: string; email: string },
	testDate: string | null,
	driver: EmailDriver | undefined,
): Promise<RenderedFailureNotice> {
	const sender = await resolveSenderIdentity(driver);
	const wpName = await purveyorName(asset.waterPurveyorId);
	const companies = await activeRepairCompaniesFor(asset.waterPurveyorId);

	const { subject, text } = failureNoticeText({
		customerName: customer.name,
		wpName,
		bfaType: asset.bfaType,
		bin: asset.bin,
		serviceAddress: asset.serviceAddress,
		testDate,
	});

	const companyBlock = repairCompanyListText(companies);
	const body = companyBlock ? `${text}\n\n${companyBlock}` : text;

	return {
		payload: {
			to: customer.email,
			subject,
			html: renderTextEmail({ subject, text: body }),
			tags: [
				{ name: "type", value: "failure_notice" },
				{ name: "wp_id", value: asset.waterPurveyorId },
				{ name: "asset_id", value: asset.id },
			],
			sender,
			recipientId: customer.id,
		},
		customerId: customer.id,
		repairCompanyCount: companies.length,
	};
}

/**
 * The purveyor's repair companies with `status = 'active'`, resolved at send
 * time — a company deactivated yesterday is not in today's email — and
 * selecting name and phone only. The email column is deliberately not in the
 * select list: `RepairCompanyListEntry` has no field to put it in, so a future
 * edit that wanted to leak it would have to change two files on purpose.
 */
async function activeRepairCompaniesFor(waterPurveyorId: string) {
	return (
		db
			.select({
				companyName: repairCompanies.companyName,
				phone: repairCompanies.phone,
			})
			.from(repairCompanies)
			.where(
				and(
					eq(repairCompanies.waterPurveyorId, waterPurveyorId),
					eq(repairCompanies.status, "active"),
				),
			)
			// Alphabetical, digits first and ignoring case (WP/Admin feedback). `id`
			// breaks the tie so two companies with one name keep a stable order
			// between one customer's email and the next.
			.orderBy(
				alphabetically(repairCompanies.companyName),
				asc(repairCompanies.id),
			)
	);
}

/**
 * Whether a submitted pass exists for the asset *after* this fail, in
 * submission-event order — `(created_at, id)`, with the id as the
 * deterministic tie-breaker, never the certifier-typed `test_date`. The same
 * comparison `dashboard.failList` makes, so the notice and the list agree on
 * what "resolved" means.
 */
async function passSubmittedAfter({
	assetId,
	waterPurveyorId,
	failCreatedAt,
	failId,
}: {
	assetId: string;
	waterPurveyorId: string;
	failCreatedAt: Date;
	failId: string;
}): Promise<boolean> {
	const [row] = await db
		.select({ id: testSubmissions.id })
		.from(testSubmissions)
		.where(
			and(
				eq(testSubmissions.bfaAssetId, assetId),
				eq(testSubmissions.waterPurveyorId, waterPurveyorId),
				eq(testSubmissions.status, "submitted"),
				eq(testSubmissions.testResult, "pass"),
				sql`(${testSubmissions.createdAt}, ${testSubmissions.id}) > (${failCreatedAt.toISOString()}::timestamptz, ${failId}::uuid)`,
			),
		)
		.limit(1);

	return row !== undefined;
}

/** The purveyor's own name for the sign-off line. */
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
	assetId: string | null,
	reason: string,
): Promise<FailureNoticeOutcome> {
	const cancelled = await cancelRunningJob({ jobId: job.id, reason });

	if (!cancelled) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_cancelled", {
		jobId: job.id,
		jobType: "failure_notice",
		assetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: {
			reason,
			trigger: "job_execution",
			submission_id: job.testSubmissionId,
		},
	});

	return { kind: "cancelled", reason };
}
