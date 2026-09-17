/**
 * The three things the rest of the application does to a notice chain.
 *
 * A "chain" is at most one live `scheduled_jobs` row per asset: the stage that
 * has not happened yet. The whole chain is never pre-created — each successful
 * notice schedules its immediate successor and nothing else — so cancelling,
 * rescheduling and resuming all deal with one row, and a stage that does not
 * exist yet cannot be left pointing at a date somebody corrected last week.
 *
 * Every function here is safe to call inside the caller's own transaction, and
 * the routers do exactly that: a reminder scheduled for an asset whose insert
 * then rolls back would be a job with no assembly behind it, mailing a customer
 * about a valve that was never registered.
 *
 * None of these check the `automated_notices` flag. That is deliberate — the
 * flag is checked when a job *runs* (`notice-handler.ts`), not when it is
 * queued, because switching the feature off has to stop notices that are
 * already scheduled and not merely prevent new ones. Scheduling against a
 * purveyor whose flag is off therefore costs one row that will cancel itself,
 * and buys the property that switching the flag on needs no backfill.
 */

import { db } from "@bfa-platform/db";
import { bfaAssets } from "@bfa-platform/db/schema";
import { and, eq } from "drizzle-orm";

import type { AuditActor } from "../lib/audit-actor";
import {
	type CalendarDay,
	compareCalendarDays,
	honoluluToday,
} from "../lib/honolulu-dates";
import { noticeDueDay, noticeRunAt } from "../lib/notice-schedule";
import {
	cancelAssetNoticeJobs,
	isNoticeJobType,
	type JobExecutor,
	liveNoticeJobsForAsset,
	pullJobForward,
	scheduleNoticeJob,
} from "./jobs";
import { logSchedulerEvent } from "./logging";

/** Why a chain was withdrawn. Read by people in `last_error`, not by code. */
export const CANCEL_REASONS = {
	noAnnualTestDate:
		"The assembly has no annual test date, so there is nothing to schedule against.",
	annualTestDateChanged:
		"The assembly's annual test date changed; the chain was rescheduled from the new date.",
	passingTest:
		"A passing test was submitted for this assembly, which ends the escalation.",
	featureDisabled:
		"Automated notices are switched off for this water purveyor.",
	assetGone: "The assembly is no longer registered to this water purveyor.",
} as const;

/** Why a stage is waiting rather than sending. */
export const HOLD_REASONS = {
	noCustomer:
		"No customer is currently attached to this assembly, so there is nobody to write to.",
	suspendedCustomer:
		"The customer currently attached to this assembly is suspended, which holds the assembly's notices.",
	noEmail:
		"The customer currently attached to this assembly has no email address.",
} as const;

type ChainContext = {
	executor?: JobExecutor;
	assetId: string;
	waterPurveyorId: string;
	actor?: AuditActor | null;
	now?: Date;
};

/**
 * Brings an asset's chain into line with its current `annual_test_date`.
 *
 * Called when an asset is registered with a date and when that date changes.
 * Two steps, in this order:
 *
 * 1. Every live stage *except* the reminder is cancelled. The whole chain hangs
 *    off one date, so a pending late notice computed from the old one is not
 *    merely early or late — it is a notice about a deadline that no longer
 *    exists. The reminder is excluded because step 2 rewrites it in place,
 *    which is one write rather than a cancel-and-insert pair and keeps the
 *    row's history readable.
 * 2. The reminder is scheduled, or its `run_at` corrected, for the new date.
 *
 * The reminder is scheduled even when its day is already in the past. That is
 * what makes a purveyor who registers a long-overdue assembly get the
 * escalation rather than silence: the stage fires on the next tick, its
 * successor is scheduled immediately after, and the chain catches up in order.
 * It is also the build plan's acceptance criterion — "the full escalation fires
 * in order against a seeded past-due asset".
 *
 * A date that did not change produces no writes: the cancel matches nothing and
 * the upsert's own predicate refuses a row that already carries this `run_at`.
 * Callers still guard on the change themselves, so the ordinary save does not
 * reach the database at all.
 */
export async function reconcileAssetNoticeChain({
	executor = db,
	assetId,
	waterPurveyorId,
	annualTestDate,
	actor = null,
	trigger,
}: ChainContext & {
	annualTestDate: CalendarDay | null;
	/** What caused the reconciliation, for the log line. */
	trigger: "asset_created" | "annual_test_date_changed";
}): Promise<void> {
	if (!annualTestDate) {
		await withdrawChain({
			executor,
			assetId,
			waterPurveyorId,
			actor,
			reason: CANCEL_REASONS.noAnnualTestDate,
			trigger,
		});

		return;
	}

	const obsolete = await cancelAssetNoticeJobs({
		executor,
		assetId,
		reason: CANCEL_REASONS.annualTestDateChanged,
		stages: ["late_notice_1", "late_notice_2", "final_notice"],
	});

	for (const job of obsolete) {
		logSchedulerEvent("scheduler_job_cancelled", {
			jobId: job.id,
			jobType: job.jobType,
			assetId,
			waterPurveyorId,
			actor,
			extra: { reason: CANCEL_REASONS.annualTestDateChanged, trigger },
		});
	}

	const runAt = noticeRunAt(annualTestDate, "reminder");
	const scheduled = await scheduleNoticeJob({
		executor,
		assetId,
		waterPurveyorId,
		stage: "reminder",
		runAt,
	});

	// Nothing written means the reminder was already queued for this exact
	// instant. Logging it would put a scheduling record against a schedule
	// nobody changed, which is the same rule the asset and template mutations
	// follow for a save that changes nothing.
	if (!scheduled) return;

	// Inserted rows carry one `now()` in both timestamps; the `set_updated_at`
	// trigger moves `updated_at` on the conflict-update path and leaves
	// `created_at` where it was. That is the difference between "this asset had
	// no reminder" and "this asset's reminder moved", which is what the two
	// event names mean.
	const inserted =
		scheduled.createdAt.getTime() === scheduled.updatedAt.getTime();

	logSchedulerEvent(
		inserted ? "scheduler_job_scheduled" : "scheduler_job_rescheduled",
		{
			jobId: scheduled.id,
			jobType: scheduled.jobType,
			assetId,
			waterPurveyorId,
			actor,
			extra: {
				trigger,
				annual_test_date: annualTestDate,
				due_day: noticeDueDay(annualTestDate, "reminder"),
				run_at: runAt.toISOString(),
			},
		},
	);
}

/**
 * Ends an asset's chain because a passing test was submitted for it.
 *
 * A passing test is the outcome the whole escalation exists to produce, so every
 * remaining stage is withdrawn — including one a handler is running right now,
 * which `completeRunningJob` refuses to complete afterwards.
 *
 * Only ever called for a *submitted* row with `test_result = 'pass'`. A draft
 * sends nothing and cancels nothing: a half-finished test is the certifier's
 * working copy and has not been attested to, so it cannot end a purveyor's
 * escalation. A failed test cancels nothing either — the assembly is still
 * untested as far as compliance is concerned, and Workflow 3 is what responds
 * to a failure.
 */
export async function cancelNoticeChainForPassingTest({
	executor = db,
	assetId,
	waterPurveyorId,
	actor = null,
	submissionId,
}: ChainContext & { submissionId: string }): Promise<void> {
	const cancelled = await cancelAssetNoticeJobs({
		executor,
		assetId,
		reason: CANCEL_REASONS.passingTest,
	});

	for (const job of cancelled) {
		logSchedulerEvent("scheduler_job_cancelled", {
			jobId: job.id,
			jobType: job.jobType,
			assetId,
			waterPurveyorId,
			actor,
			extra: {
				reason: CANCEL_REASONS.passingTest,
				trigger: "passing_test_submitted",
				submission_id: submissionId,
			},
		});
	}
}

/**
 * Resumes a chain that was holding for want of a recipient.
 *
 * Called when `assignCustomer` attaches an **active** customer to an asset. The
 * hold rule (PRD § 9, "Email routing / suspended customers") says an asset's
 * notices stop entirely until a new customer is attached to the BIN, and does
 * not say where the pipeline picks up when one is. This is the answer this
 * feature ships, and it is the smallest durable one:
 *
 * **The single unsent stage resumes, and nothing already sent is replayed.**
 * Because the chain is never pre-created, the only live row is the stage that
 * has not happened; if its due day has already passed it is pulled forward to
 * run on the next tick, and if it is still in the future it is left alone. A
 * stage that already sent is a `completed` row and this function cannot reach
 * it. So a customer attached three months into an escalation receives the stage
 * that was waiting — not the reminder and two late notices the previous
 * occupant's suspension swallowed.
 *
 * The alternative readings are real and were not chosen: restarting the chain
 * from the reminder (which mails a new occupant about a deadline that has
 * already passed) and skipping straight to the stage the calendar says is now
 * due (which can jump a customer from silence to a final notice). Both are a
 * product decision rather than an engineering one; this one is flagged in the
 * docs so it can be changed on purpose.
 *
 * Nothing happens for a suspended customer, and nothing happens when the asset
 * has no date — the hold is correct in both cases.
 */
export async function resumeHeldNoticeChain({
	executor = db,
	assetId,
	waterPurveyorId,
	actor = null,
	now = new Date(),
}: ChainContext): Promise<void> {
	const [asset] = await executor
		.select({ annualTestDate: bfaAssets.annualTestDate })
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	const annualTestDate = asset?.annualTestDate;

	if (!annualTestDate) return;

	const today = honoluluToday(now);
	const live = await liveNoticeJobsForAsset({ executor, assetId });

	for (const job of live) {
		if (job.status !== "pending" || !isNoticeJobType(job.jobType)) continue;

		const dueDay = noticeDueDay(annualTestDate, job.jobType);

		// Already due in Hawaii, but parked in the future by the hold. Anything
		// not yet due keeps its own schedule — resuming is about undoing a wait,
		// not about sending a notice early.
		if (compareCalendarDays(dueDay, today) > 0) continue;

		const resumed = await pullJobForward({
			executor,
			jobId: job.id,
			runAt: now,
		});

		if (!resumed) continue;

		logSchedulerEvent("scheduler_job_resumed", {
			jobId: resumed.id,
			jobType: resumed.jobType,
			assetId,
			waterPurveyorId,
			actor,
			extra: {
				trigger: "active_customer_attached",
				due_day: dueDay,
				held_until: job.runAt.toISOString(),
			},
		});
	}
}

/** Cancels every live stage, for the reasons that are not a reschedule. */
async function withdrawChain({
	executor,
	assetId,
	waterPurveyorId,
	actor,
	reason,
	trigger,
}: {
	executor: JobExecutor;
	assetId: string;
	waterPurveyorId: string;
	actor: AuditActor | null;
	reason: string;
	trigger: string;
}): Promise<void> {
	const cancelled = await cancelAssetNoticeJobs({ executor, assetId, reason });

	for (const job of cancelled) {
		logSchedulerEvent("scheduler_job_cancelled", {
			jobId: job.id,
			jobType: job.jobType,
			assetId,
			waterPurveyorId,
			actor,
			extra: { reason, trigger },
		});
	}
}
