/**
 * The application-level scheduler: a Node timer, a Postgres table, and nothing
 * else.
 *
 * No Vercel Cron, no OS cron, no provider-specific queue — a hard project
 * constraint (`bfa-requirements`, "Portability"), because the platform has to be
 * deployable from a plain Dockerfile without rewriting its background work. All
 * durable state is in `scheduled_jobs`, so the process is disposable: it can be
 * killed, restarted, scaled to two instances, or moved to a different host, and
 * the schedule is whatever the table says.
 *
 * What a tick does, in order:
 *
 * 1. Recompute `bfa_assets.asset_status` from `annual_test_date`. One statement
 *    that writes only the rows whose status is wrong.
 * 2. Claim up to {@link CLAIM_BATCH_SIZE} due jobs, `pending → running`, in a
 *    single conditional statement.
 * 3. Run each one through its handler, and apply the retry policy to anything
 *    that throws.
 *
 * Startup does one thing first: reclaim the `running` rows a previous process
 * died holding. Overdue `pending` rows need no special treatment — the first
 * tick claims anything whose `run_at` has passed, whether that was a minute ago
 * or during last month's outage — which is what makes "process missed jobs on
 * boot" a property of the claim query rather than a separate recovery path that
 * could drift from it.
 *
 * Two instances are safe and neither coordinates with the other: the claim is
 * atomic, and a job's one email is sent under the job's own provider
 * idempotency key, so even two passes over one job produce one message. What is
 * *not* safe is assuming the loop runs at all — the schedule
 * is the table, so nothing in the application waits on a tick or reads a result
 * from one.
 */

import type { EmailDriver } from "../lib/email";
import type { NoticeType } from "../lib/notice-defaults";
import { recomputeAssetStatuses } from "./asset-status";
import {
	CLAIM_BATCH_SIZE,
	MAX_JOB_ATTEMPTS,
	STALE_RUNNING_AFTER_MS,
	TICK_INTERVAL_MS,
	UNHANDLED_JOB_DEFER_MS,
} from "./config";
import {
	type FailureNoticeOutcome,
	runFailureNoticeJob,
} from "./failure-notice";
import {
	claimDueJobs,
	deferUnhandledJob,
	isNoticeJobType,
	noticeIdempotencyKey,
	recordJobFailure,
	type ScheduledJob,
	staleRunningJobs,
} from "./jobs";
import { logSchedulerEvent } from "./logging";
import { type NoticeJobOutcome, runNoticeJob } from "./notice-handler";

export { recomputeAssetStatuses } from "./asset-status";
export {
	FAILURE_CANCEL_REASONS,
	runFailureNoticeJob,
	scheduleFailureNotice,
} from "./failure-notice";
export {
	CANCEL_REASONS,
	cancelNoticeChainForPassingTest,
	HOLD_REASONS,
	reconcileAssetNoticeChain,
	resumeHeldNoticeChain,
} from "./notice-chain";
export {
	applySubmittedTestResult,
	type SubmissionLifecycleTrigger,
} from "./submission-lifecycle";

/**
 * A handler for one `job_type`.
 *
 * Every handler owns the terminal state of its own job — it completes, cancels
 * or holds the row itself — and reports what it did. That is why the signature
 * returns an outcome rather than `void`: the loop logs and counts, it does not
 * decide. The one thing the loop does decide is what happens when a handler
 * *throws*, because a retry policy that each handler implemented separately
 * would be four retry policies.
 */
type JobHandler = (
	job: ScheduledJob,
) => Promise<NoticeJobOutcome | FailureNoticeOutcome>;

/**
 * Handlers by `job_type`.
 *
 * Partial on purpose. `ag_renewal` (Workflow 2) is declared in the `job_type`
 * enum and not implemented here, and `fail_list_check` is declared and
 * *deliberately never implemented*: fail-list membership — including its
 * 30-day entry rule — is computed from test history at read time, so there is
 * nothing for a scheduled recheck to do. A
 * job of an unhandled type is left alone and logged rather than being claimed
 * and failed, so shipping this workflow cannot consume the retry budget of a
 * row a later workflow will want.
 */
function handlerFor(
	job: ScheduledJob,
	driver: EmailDriver | undefined,
): JobHandler | null {
	if (isNoticeJobType(job.jobType)) {
		const stage: NoticeType = job.jobType;

		return (claimed) => runNoticeJob(claimed, stage, { driver });
	}

	if (job.jobType === "failure_notice") {
		return (claimed) => runFailureNoticeJob(claimed, { driver });
	}

	return null;
}

/**
 * Where a job's delivery stands, for the claim and recovery lines. Booleans
 * only — the payload itself, which carries an address and a message body, is
 * never logged from here.
 */
function deliveryState(job: ScheduledJob) {
	return {
		idempotency_key:
			isNoticeJobType(job.jobType) || job.jobType === "failure_notice"
				? noticeIdempotencyKey(job.id)
				: null,
		delivery_recorded: job.providerMessageId !== null,
		delivery_in_doubt:
			job.deliveryAttemptedAt !== null && job.providerMessageId === null,
	};
}

export type TickResult = {
	claimed: number;
	sent: number;
	held: number;
	cancelled: number;
	failed: number;
	retrying: number;
	superseded: number;
	unhandled: number;
	statusesChanged: number;
};

const EMPTY_TICK: TickResult = {
	claimed: 0,
	sent: 0,
	held: 0,
	cancelled: 0,
	failed: 0,
	retrying: 0,
	superseded: 0,
	unhandled: 0,
	statusesChanged: 0,
};

/**
 * One pass of the loop. Exported so a test — and a future one-shot worker
 * command — can run the scheduler's whole behaviour without a timer.
 *
 * Jobs are processed one at a time, not with `Promise.all`. A batch is at most
 * {@link CLAIM_BATCH_SIZE} notices, the work is a handful of queries and one
 * provider call each, and serial execution keeps the connection pool out of the
 * failure modes that a burst of parallel transactions introduces for no
 * user-visible gain.
 */
export async function runSchedulerTick({
	now = new Date(),
	limit = CLAIM_BATCH_SIZE,
	driver,
}: {
	now?: Date;
	limit?: number;
	/**
	 * The email driver to send through. Omitted in production, where `sendEmail`
	 * selects one from `EMAIL_DRIVER`; tests pass a stand-in for the provider.
	 */
	driver?: EmailDriver;
} = {}): Promise<TickResult> {
	const result: TickResult = { ...EMPTY_TICK };

	result.statusesChanged = await recomputeAssetStatuses({ now });

	const jobs = await claimDueJobs({ now, limit });
	result.claimed = jobs.length;

	for (const job of jobs) {
		logSchedulerEvent("scheduler_job_claimed", {
			jobId: job.id,
			jobType: job.jobType,
			assetId: job.bfaAssetId,
			waterPurveyorId: job.waterPurveyorId,
			extra: {
				run_at: job.runAt.toISOString(),
				attempts: job.attempts,
				...deliveryState(job),
			},
		});

		const handler = handlerFor(job, driver);

		if (!handler) {
			// Put it straight back, with its retry budget intact: there is nothing
			// wrong with the row, this build simply has no handler for its type.
			result.unhandled += 1;
			await deferUnhandledJob({
				jobId: job.id,
				reason: `No handler is registered for job type ${job.jobType} in this build.`,
				runAt: new Date(now.getTime() + UNHANDLED_JOB_DEFER_MS),
			});

			continue;
		}

		try {
			const outcome = await handler(job);

			if (outcome.kind === "sent") result.sent += 1;
			if (outcome.kind === "held") result.held += 1;
			if (outcome.kind === "cancelled") result.cancelled += 1;
			if (outcome.kind === "superseded") result.superseded += 1;
			if (outcome.kind === "delivery_unconfirmed") result.failed += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const outcome = await recordJobFailure({ job, error: message, now });

			if (outcome.kind === "failed") result.failed += 1;
			else if (outcome.kind === "retrying") result.retrying += 1;
			else result.superseded += 1;

			logSchedulerEvent(
				outcome.kind === "failed"
					? "scheduler_job_failed"
					: outcome.kind === "retrying"
						? "scheduler_job_retrying"
						: "scheduler_job_superseded",
				{
					jobId: job.id,
					jobType: job.jobType,
					assetId: job.bfaAssetId,
					waterPurveyorId: job.waterPurveyorId,
					extra: {
						error: message,
						attempts: outcome.attempts,
						max_attempts: MAX_JOB_ATTEMPTS,
						next_run_at: outcome.runAt?.toISOString() ?? null,
					},
				},
			);
		}
	}

	return result;
}

/**
 * Hands every abandoned `running` row back to the loop, or fails it.
 *
 * A crashed run counts as an attempt. Not counting it would let a handler that
 * reliably kills its process be reclaimed forever; counting it means the same
 * row is tried a bounded number of times and then reported as `failed` with the
 * reason in `last_error`, which is something a person can act on.
 */
export async function recoverInterruptedJobs({
	now = new Date(),
}: {
	now?: Date;
} = {}): Promise<{ recovered: number; failed: number }> {
	const stale = await staleRunningJobs({
		staleBefore: new Date(now.getTime() - STALE_RUNNING_AFTER_MS),
	});

	let recovered = 0;
	let failed = 0;

	for (const job of stale) {
		const outcome = await recordJobFailure({
			job,
			error:
				"The process running this job stopped before it finished. Reclaimed on startup.",
			now,
		});

		if (outcome.kind === "failed") failed += 1;
		else if (outcome.kind === "retrying") recovered += 1;

		logSchedulerEvent(
			outcome.kind === "failed"
				? "scheduler_job_failed"
				: outcome.kind === "retrying"
					? "scheduler_job_recovered"
					: "scheduler_job_superseded",
			{
				jobId: job.id,
				jobType: job.jobType,
				assetId: job.bfaAssetId,
				waterPurveyorId: job.waterPurveyorId,
				extra: {
					attempts: outcome.attempts,
					max_attempts: MAX_JOB_ATTEMPTS,
					next_run_at: outcome.runAt?.toISOString() ?? null,
					// A reclaimed job with an attempt in doubt is retried with the same
					// frozen payload and idempotency key, so the provider settles it
					// without a second email; one with a recorded delivery only has
					// its completion left to do.
					...deliveryState(job),
				},
			},
		);
	}

	return { recovered, failed };
}

export type SchedulerHandle = {
	/** Stops the timer. In-flight work finishes; nothing new is claimed. */
	stop: () => Promise<void>;
};

let running: SchedulerHandle | null = null;

/**
 * Starts the loop, and returns the handle that stops it.
 *
 * Idempotent per process: a second call returns the running handle rather than
 * starting a second timer, because a module that is imported twice — which
 * happens readily in a Next.js dev server — must not double the tick rate.
 * Two *processes* are fine; two timers in one process are just waste.
 *
 * Ticks never overlap. A pass that is still running when the interval fires is
 * left to finish and the fire is skipped, so a slow provider cannot pile ticks
 * on top of each other. Correctness does not depend on this — the claim query
 * already makes concurrent passes safe — but it keeps the connection pool
 * predictable.
 */
export function startScheduler({
	intervalMs = TICK_INTERVAL_MS,
}: {
	intervalMs?: number;
} = {}): SchedulerHandle {
	if (running) return running;

	let inFlight: Promise<unknown> = Promise.resolve();
	let ticking = false;
	let stopped = false;

	const tick = async () => {
		if (ticking || stopped) return;

		ticking = true;

		try {
			const result = await runSchedulerTick();

			// Silence on an idle tick. A line a minute, forever, saying nothing
			// happened would bury the lines that matter.
			if (
				result.claimed > 0 ||
				result.statusesChanged > 0 ||
				result.unhandled > 0
			) {
				logSchedulerEvent("scheduler_tick", { extra: { ...result } });
			}
		} catch (error) {
			// A tick that throws is a database or connectivity problem, not a job
			// problem: the row stays where it was and the next tick tries again.
			logSchedulerEvent("scheduler_tick", {
				extra: {
					error: error instanceof Error ? error.message : String(error),
				},
			});
		} finally {
			ticking = false;
		}
	};

	const interval = setInterval(() => {
		inFlight = tick();
	}, intervalMs);

	const handle: SchedulerHandle = {
		async stop() {
			stopped = true;
			clearInterval(interval);
			running = null;
			await inFlight.catch(() => undefined);
			logSchedulerEvent("scheduler_stopped");
		},
	};

	running = handle;

	inFlight = (async () => {
		const recovery = await recoverInterruptedJobs();

		logSchedulerEvent("scheduler_started", {
			extra: {
				interval_ms: intervalMs,
				recovered_count: recovery.recovered,
				failed_count: recovery.failed,
			},
		});

		await tick();
	})().catch((error) => {
		logSchedulerEvent("scheduler_started", {
			extra: {
				interval_ms: intervalMs,
				error: error instanceof Error ? error.message : String(error),
			},
		});
	});

	return handle;
}
