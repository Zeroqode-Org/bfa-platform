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
	insertNoticeJob,
	isNoticeJobType,
	type JobExecutor,
	liveNoticeJobsForAsset,
	lockAssetForChain,
	pullJobForward,
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
	noBin: "The assembly has no BIN yet, so it is not on the notice schedule.",
} as const;

/** Why a stage is waiting rather than sending. */
export const HOLD_REASONS = {
	noCustomer:
		"No customer is currently attached to this assembly, so there is nobody to write to.",
	suspendedCustomer:
		"The customer currently attached to this assembly is suspended, which holds the assembly's notices.",
	noEmail:
		"The customer currently attached to this assembly has no email address.",
	blockedPurveyor:
		"The water purveyor is blocked, which holds every automated email to its customers.",
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
 * Three steps, in one transaction, under the asset's row lock:
 *
 * 1. **Every** live stage is cancelled — `pending` or `running`, the reminder
 *    included. The whole chain hangs off one date, so any live job computed
 *    from the old one is a notice about a deadline that no longer exists.
 *    A `running` reminder matters most: its handler may be mid-send, and only
 *    cancelling the row is what stops it — `completeRunningJob` then refuses to
 *    complete it and no successor is scheduled from the old date. Rewriting the
 *    reminder's `run_at` in place cannot do that, because a running row is
 *    deliberately never rewritten.
 * 2. Exactly one replacement reminder is inserted, for the new date. It is a
 *    fresh row with a fresh id, and therefore a fresh provider idempotency key,
 *    so it can never be confused with an attempt made for the old date.
 * 3. The asset lock (`lockAssetForChain`) is what keeps this atomic against a
 *    handler finishing a stage at the same moment: the two serialise, so either
 *    the handler's successor is committed before this runs and is cancelled by
 *    step 1, or this commits first and the handler finds its row cancelled.
 *
 * The reminder is scheduled even when its day is already in the past. That is
 * what makes a purveyor who registers a long-overdue assembly get the
 * escalation rather than silence: the stage fires on the next tick, its
 * successor is scheduled immediately after, and the chain catches up in order.
 * It is also the build plan's acceptance criterion — "the full escalation fires
 * in order against a seeded past-due asset".
 *
 * A chain already in the target state — one live reminder at exactly this
 * `run_at` and nothing else — is left alone: no cancel, no insert, no log line.
 * Callers guard on the date actually changing as well, so the ordinary save
 * does not reach this function at all.
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
	trigger:
		| "asset_created"
		| "annual_test_date_changed"
		| "passing_test_submitted"
		| "asset_bin_assigned";
}): Promise<void> {
	await lockAssetForChain(executor, assetId);

	// Read under the lock, so a BIN assigned in the caller's own transaction is
	// the one seen. A no-BIN asset has no chain: nobody is reminded about an
	// assembly the register cannot name.
	if (!annualTestDate || !(await assetHasBin(executor, assetId))) {
		await withdrawChain({
			executor,
			assetId,
			waterPurveyorId,
			actor,
			reason: annualTestDate
				? CANCEL_REASONS.noBin
				: CANCEL_REASONS.noAnnualTestDate,
			trigger,
		});

		return;
	}

	const runAt = noticeRunAt(annualTestDate, "reminder");
	const live = await liveNoticeJobsForAsset({ executor, assetId });

	// Already exactly right: nothing to write, and nothing to log. The same rule
	// the asset and template mutations follow for a save that changes nothing.
	const [only] = live;
	if (
		live.length === 1 &&
		only?.jobType === "reminder" &&
		only.runAt.getTime() === runAt.getTime()
	) {
		return;
	}

	await withdrawChain({
		executor,
		assetId,
		waterPurveyorId,
		actor,
		reason: CANCEL_REASONS.annualTestDateChanged,
		trigger,
	});

	const scheduled = await insertNoticeJob({
		executor,
		assetId,
		waterPurveyorId,
		stage: "reminder",
		runAt,
	});

	logSchedulerEvent("scheduler_job_scheduled", {
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
			replaced_job_ids: live.map((job) => job.id),
		},
	});
}

/**
 * Whether the asset has a BIN. A no-BIN asset — registered by the wizard from
 * a test whose BIN was blank or not found (0021) — is off the notice machinery
 * entirely until the WP assigns one: no reminder chain, no failure notice.
 */
export async function assetHasBin(
	executor: Pick<typeof db, "select">,
	assetId: string,
): Promise<boolean> {
	const [asset] = await executor
		.select({ bin: bfaAssets.bin })
		.from(bfaAssets)
		.where(eq(bfaAssets.id, assetId))
		.limit(1);

	return Boolean(asset?.bin);
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
	// Serialised with a handler finishing a stage — see `lockAssetForChain`.
	// Without it, a successor inserted by a handler that has not yet committed
	// would be invisible to the cancel below and would survive the passing test.
	await lockAssetForChain(executor, assetId);

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

/** Cancels every live stage — `pending` and `running` — and logs each one. */
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
