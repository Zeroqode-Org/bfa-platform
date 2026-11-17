/**
 * What switching an optional feature back on does to the jobs the switch-off
 * already cancelled.
 *
 * The handlers read `wp_feature_flags` when a job runs, not when it is queued
 * (`notice-handler.ts`, `ag-renewal.ts`), and a job that runs while its feature
 * is off is *cancelled* — final, never retried. Scheduling alone therefore does
 * not make "switch it on later" work: every reminder whose day came round while
 * the purveyor had the add-on off is a cancelled row, and nothing else ever
 * schedules that asset again until its date changes. Turning the flag on would
 * leave exactly those assets silent.
 *
 * So turning a flag on restores them: **the stage the switch-off cancelled is
 * scheduled again, and nothing else.** Only an asset (or customer) whose *most
 * recent* job of the feature's type was cancelled for that reason is touched,
 * and only when it has nothing live. Anything a passing test, a changed date or
 * a completed chain settled is left exactly as it is, so a final notice that
 * already went out is never sent twice.
 *
 * **One email per asset, for where the calendar is now.** The restored stage is
 * recomputed from the asset's *current* date. When the stage the switch-off
 * cancelled is still ahead, it keeps its own day. When the calendar has moved
 * past it, the restore skips forward to the *latest* stage already due and
 * sends only that one, on the next tick; its successor is then due on its own,
 * future day. Replaying the missed stages in order instead would mail a
 * long-overdue customer a reminder and three late notices on consecutive ticks
 * — a reminder about a deadline that passed a year ago, then a burst. Nothing
 * earlier than the cancelled stage is ever chosen: those were already sent.
 */

import type { db } from "@bfa-platform/db";
import { bfaAssets, customers, scheduledJobs } from "@bfa-platform/db/schema";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type { AuditActor } from "../lib/audit-actor";
import {
	type CalendarDay,
	compareCalendarDays,
	honoluluToday,
} from "../lib/honolulu-dates";
import type { NoticeType } from "../lib/notice-defaults";
import {
	NOTICE_STAGES,
	noticeDueDay,
	noticeRunAt,
} from "../lib/notice-schedule";
import {
	AG_RENEWAL_CANCEL_REASONS,
	reconcileAgRenewalNotice,
} from "./ag-renewal";
import { isNoticeJobType, type JobExecutor, NOTICE_JOB_TYPES } from "./jobs";
import { logSchedulerEvent } from "./logging";
import { CANCEL_REASONS } from "./notice-chain";

/** What the restore needs from a connection or a transaction. */
type RestoreExecutor = JobExecutor & Pick<typeof db, "selectDistinctOn">;

/** A job row, reduced to what decides whether it is restored. */
export type LatestJob = {
	jobType: string;
	status: string;
	lastError: string | null;
};

/**
 * The notice stage to schedule again, or null when the asset's chain is not
 * one the switch-off ended.
 *
 * Pure, so the rule is checkable without a database: restore only when the
 * newest notice job is a cancellation *for the flag*. Any other last word — a
 * pending or running job, a completed final notice, a passing test, a changed
 * date — means something other than the flag decided the chain's state.
 */
export function noticeStageToRestore(
	latest: LatestJob | undefined,
): NoticeType | null {
	if (!latest) return null;
	if (latest.status !== "cancelled") return null;
	if (latest.lastError !== CANCEL_REASONS.featureDisabled) return null;

	return isNoticeJobType(latest.jobType) ? latest.jobType : null;
}

/**
 * Which stage a restored chain sends next: the cancelled stage when it is not
 * due yet, otherwise the latest stage at or after it whose day has come.
 *
 * Pure — `today` is the Hawaii calendar day — so the "one email for where the
 * calendar is now" rule is checkable without a clock or a database.
 */
export function currentStageFrom(
	cancelledStage: NoticeType,
	annualTestDate: CalendarDay,
	today: CalendarDay,
): NoticeType {
	const from = NOTICE_STAGES.indexOf(cancelledStage);
	let current = cancelledStage;

	for (const stage of NOTICE_STAGES.slice(from)) {
		if (compareCalendarDays(noticeDueDay(annualTestDate, stage), today) > 0) {
			break;
		}
		current = stage;
	}

	return current;
}

/** Whether a customer's newest AG renewal job was cancelled by the flag. */
export function agRenewalNeedsRestore(latest: LatestJob | undefined): boolean {
	return (
		latest?.status === "cancelled" &&
		latest.lastError === AG_RENEWAL_CANCEL_REASONS.featureDisabled
	);
}

/**
 * Re-schedules every notice chain in one purveyor that the `automated_notices`
 * switch-off cancelled. Returns how many assets were restored.
 *
 * Runs inside the caller's transaction — the same one that turns the flag on —
 * so the flag and the restored jobs commit together or not at all.
 */
export async function restoreNoticeChainsForPurveyor({
	executor,
	waterPurveyorId,
	actor,
	now = new Date(),
}: {
	executor: RestoreExecutor;
	waterPurveyorId: string;
	actor: AuditActor | null;
	now?: Date;
}): Promise<number> {
	// Newest notice job per asset in this purveyor, in one statement.
	const latestJobs = await executor
		.selectDistinctOn([scheduledJobs.bfaAssetId], {
			assetId: scheduledJobs.bfaAssetId,
			jobType: scheduledJobs.jobType,
			status: scheduledJobs.status,
			lastError: scheduledJobs.lastError,
		})
		.from(scheduledJobs)
		.where(
			and(
				eq(scheduledJobs.waterPurveyorId, waterPurveyorId),
				isNotNull(scheduledJobs.bfaAssetId),
				inArray(scheduledJobs.jobType, [...NOTICE_JOB_TYPES]),
			),
		)
		.orderBy(
			scheduledJobs.bfaAssetId,
			desc(scheduledJobs.createdAt),
			desc(scheduledJobs.id),
		);

	const cancelledStages = new Map<string, NoticeType>();
	for (const latest of latestJobs) {
		const stage = noticeStageToRestore(latest);
		if (latest.assetId && stage) cancelledStages.set(latest.assetId, stage);
	}

	if (cancelledStages.size === 0) return 0;

	const candidateIds = [...cancelledStages.keys()];

	// A fixed number of statements however many assets qualify — the flag
	// switch is one request, and a purveyor with hundreds of assemblies must
	// not turn it into hundreds of round trips inside one transaction.
	//
	// 1. Lock every candidate at once, in id order. The scheduler handler
	//    takes one asset's lock at a time (`lockAssetForChain`) and never a
	//    second, so a single ordered lock here cannot deadlock with it: either
	//    a handler finished first and its successor is live below, or it waits
	//    for this commit and finds the restored job instead.
	const assets = await executor
		.select({
			id: bfaAssets.id,
			bin: bfaAssets.bin,
			annualTestDate: bfaAssets.annualTestDate,
		})
		.from(bfaAssets)
		.where(
			and(
				inArray(bfaAssets.id, candidateIds),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.orderBy(asc(bfaAssets.id))
		.for("update");

	// 2. Read under the locks: anything live wins — a date correction, or a
	//    handler that scheduled a successor before the lock was taken.
	const liveRows = await executor
		.select({ assetId: scheduledJobs.bfaAssetId })
		.from(scheduledJobs)
		.where(
			and(
				inArray(scheduledJobs.bfaAssetId, candidateIds),
				inArray(scheduledJobs.status, ["pending", "running"]),
				inArray(scheduledJobs.jobType, [...NOTICE_JOB_TYPES]),
			),
		);
	const hasLive = new Set(liveRows.map((row) => row.assetId));

	const today = honoluluToday(now);
	const plans = assets.flatMap((asset) => {
		const cancelled = cancelledStages.get(asset.id);

		// No BIN or no date: nothing a notice could name or count down to.
		if (!cancelled || !asset.bin || !asset.annualTestDate) return [];
		if (hasLive.has(asset.id)) return [];

		const stage = currentStageFrom(cancelled, asset.annualTestDate, today);

		return [
			{
				assetId: asset.id,
				annualTestDate: asset.annualTestDate,
				cancelled,
				stage,
				runAt: noticeRunAt(asset.annualTestDate, stage),
			},
		];
	});

	if (plans.length === 0) return 0;

	// 3. One insert for all of them.
	const inserted = await executor
		.insert(scheduledJobs)
		.values(
			plans.map((plan) => ({
				jobType: plan.stage,
				bfaAssetId: plan.assetId,
				waterPurveyorId,
				runAt: plan.runAt,
				status: "pending" as const,
			})),
		)
		.returning({
			id: scheduledJobs.id,
			jobType: scheduledJobs.jobType,
			assetId: scheduledJobs.bfaAssetId,
		});

	const byAsset = new Map(plans.map((plan) => [plan.assetId, plan]));

	for (const job of inserted) {
		const plan = job.assetId ? byAsset.get(job.assetId) : undefined;
		if (!plan) continue;

		logSchedulerEvent("scheduler_job_scheduled", {
			jobId: job.id,
			jobType: job.jobType,
			assetId: plan.assetId,
			waterPurveyorId,
			actor,
			extra: {
				trigger: "feature_enabled",
				annual_test_date: plan.annualTestDate,
				due_day: noticeDueDay(plan.annualTestDate, plan.stage),
				run_at: plan.runAt.toISOString(),
				cancelled_stage: plan.cancelled,
			},
		});
	}

	return inserted.length;
}

/**
 * Re-schedules every AG renewal notice in one purveyor that the
 * `ag_renewal_notice` switch-off cancelled. Returns how many customers were
 * restored.
 *
 * The scheduling itself is `reconcileAgRenewalNotice`, which takes the
 * customer's lock, re-reads nothing it was not given and writes nothing when a
 * live job already exists — so the customer's *current* rate and date decide,
 * and a customer moved off the agricultural rate is not restored.
 */
export async function restoreAgRenewalsForPurveyor({
	executor,
	waterPurveyorId,
	actor,
}: {
	executor: RestoreExecutor;
	waterPurveyorId: string;
	actor: AuditActor | null;
}): Promise<number> {
	const latestJobs = await executor
		.selectDistinctOn([scheduledJobs.customerId], {
			customerId: scheduledJobs.customerId,
			jobType: scheduledJobs.jobType,
			status: scheduledJobs.status,
			lastError: scheduledJobs.lastError,
		})
		.from(scheduledJobs)
		.where(
			and(
				eq(scheduledJobs.waterPurveyorId, waterPurveyorId),
				isNotNull(scheduledJobs.customerId),
				eq(scheduledJobs.jobType, "ag_renewal"),
			),
		)
		.orderBy(
			scheduledJobs.customerId,
			desc(scheduledJobs.createdAt),
			desc(scheduledJobs.id),
		);

	const customerIds = latestJobs
		.filter(agRenewalNeedsRestore)
		.map((job) => job.customerId)
		.filter((id): id is string => id !== null);

	if (customerIds.length === 0) return 0;

	const rows = await executor
		.select({
			id: customers.id,
			rateCategory: customers.rateCategory,
			agRenewalDate: customers.agRenewalDate,
		})
		.from(customers)
		.where(
			and(
				eq(customers.waterPurveyorId, waterPurveyorId),
				inArray(customers.id, customerIds),
			),
		);

	let restored = 0;

	for (const customer of rows) {
		if (customer.rateCategory !== "agricultural" || !customer.agRenewalDate) {
			continue;
		}

		const scheduled = await reconcileAgRenewalNotice({
			executor,
			customerId: customer.id,
			waterPurveyorId,
			rateCategory: customer.rateCategory,
			agRenewalDate: customer.agRenewalDate,
			actor,
			trigger: "feature_enabled",
		});

		if (scheduled) restored += 1;
	}

	return restored;
}
