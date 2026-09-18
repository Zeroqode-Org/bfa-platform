/**
 * Every statement that touches `scheduled_jobs`.
 *
 * One module rather than queries spread through handlers, because the table's
 * invariants are all *conditional writes* and a single caller that forgets a
 * predicate breaks them silently:
 *
 * - **A job is claimed exactly once.** {@link claimDueJobs} moves
 *   `pending → running` inside one statement, over rows locked with
 *   `FOR UPDATE SKIP LOCKED`, so two processes ticking at the same second take
 *   disjoint sets and neither waits on the other.
 * - **A job sends at most one email, and its delivery is never assumed.** The
 *   rendered message is frozen once ({@link freezeDelivery}) and every attempt
 *   replays it under the job's own provider idempotency key, so the provider
 *   de-duplicates retries; the outcome is written only from the provider's
 *   answer ({@link recordDelivery}).
 * - **A job that was withdrawn mid-flight does not advance the chain.**
 *   {@link completeRunningJob} only completes a row that is still `running`, so
 *   a passing test or a corrected date that cancelled the job underneath the
 *   handler wins the race rather than being overwritten by it.
 *
 * Nothing here reads a purveyor from a request, because nothing here runs in
 * one: the scheduler process has no caller and no RLS. Every function that can
 * reach a row takes the tenant explicitly, and the callers pass the *asset's*
 * purveyor rather than a remembered one.
 */

import { db } from "@bfa-platform/db";
import {
	type FrozenEmailPayload,
	scheduledJobs,
} from "@bfa-platform/db/schema";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { NoticeType } from "../lib/notice-defaults";
import { NOTICE_STAGES } from "../lib/notice-schedule";
import { CLAIM_BATCH_SIZE, MAX_JOB_ATTEMPTS, retryDelayMs } from "./config";

export type ScheduledJob = typeof scheduledJobs.$inferSelect;

/**
 * The executor a write runs on: the pooled connection, or an open transaction.
 *
 * Structural rather than a union of Drizzle's types, the same way
 * `insertAsset` in `routers/assets.ts` takes `Pick<typeof db, "insert">`. What
 * it buys is the thing that matters for correctness: scheduling a reminder can
 * sit inside the same transaction as the asset insert that justifies it, so a
 * rolled-back asset never leaves a job behind to mail its customer.
 */
export type JobExecutor = Pick<
	typeof db,
	"select" | "insert" | "update" | "execute"
>;

/** The `job_type` values that belong to the escalation chain. */
export const NOTICE_JOB_TYPES = NOTICE_STAGES;

export function isNoticeJobType(jobType: string): jobType is NoticeType {
	return (NOTICE_JOB_TYPES as readonly string[]).includes(jobType);
}

/** A row in a status the scheduler still intends to act on. */
const LIVE_STATUSES = ["pending", "running"] as const;

function isLive() {
	return inArray(scheduledJobs.status, [...LIVE_STATUSES]);
}

/**
 * The partial unique index from `0012`, as an `ON CONFLICT` target predicate.
 *
 * Written out rather than inferred, because Postgres needs the predicate to
 * choose a partial index for conflict resolution. It has to stay the same
 * expression the index was created with — the index definition lives in the
 * migration and in `packages/db/src/schema/scheduled-jobs.ts`, and this is the
 * third place it is stated, which is the cost of a partial index used as an
 * upsert target.
 */
const LIVE_ASSET_JOB_CONFLICT = sql`${scheduledJobs.status} in ('pending', 'running') and ${scheduledJobs.bfaAssetId} is not null`;

/**
 * Creates the one live job for `stage` on this asset — used for a stage's
 * successor — or leaves an equivalent pending one as it is.
 *
 * An upsert on the live-job index, so "this asset already has this stage
 * pending" is resolved by the database rather than by a read the caller made a
 * moment earlier, and a completion that is retried cannot queue the successor
 * twice. A date change does *not* come through here: it cancels the whole chain
 * and inserts a fresh reminder (`insertNoticeJob`), because a running job must
 * be withdrawn, never rewritten.
 *
 * A write happens only if it changes something. The `setWhere` refuses to touch
 * a row that already carries this `run_at`, which is what keeps a save that
 * changed nothing from moving `updated_at` and emitting a scheduling line for a
 * schedule nobody changed; and it refuses to touch a `running` row at all,
 * because moving the `run_at` of a job a handler is inside would rewrite the
 * schedule of work already in progress.
 *
 * Returns the row when something was written and `null` when the schedule was
 * already correct — which is what the caller logs the difference between.
 */
export async function scheduleNoticeJob({
	executor = db,
	assetId,
	waterPurveyorId,
	stage,
	runAt,
}: {
	executor?: JobExecutor;
	assetId: string;
	waterPurveyorId: string;
	stage: NoticeType;
	runAt: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.insert(scheduledJobs)
		.values({
			jobType: stage,
			bfaAssetId: assetId,
			waterPurveyorId,
			runAt,
			status: "pending",
		})
		.onConflictDoUpdate({
			target: [scheduledJobs.bfaAssetId, scheduledJobs.jobType],
			targetWhere: LIVE_ASSET_JOB_CONFLICT,
			set: { runAt, lastError: null },
			setWhere: and(
				eq(scheduledJobs.status, "pending"),
				or(
					sql`${scheduledJobs.runAt} <> ${runAt.toISOString()}::timestamptz`,
					sql`${scheduledJobs.lastError} is not null`,
				),
			),
		})
		.returning();

	return row ?? null;
}

/**
 * Inserts a new pending job for `stage`. A plain insert, not an upsert.
 *
 * Used where the caller has just withdrawn every live job for the asset under
 * the asset's lock, so nothing live can conflict. If something does, the live-job
 * index refuses it and the caller's transaction fails loudly — which is the
 * right outcome for a state that should be impossible, and better than quietly
 * reusing a row that belongs to a different date.
 */
export async function insertNoticeJob({
	executor = db,
	assetId,
	waterPurveyorId,
	stage,
	runAt,
}: {
	executor?: JobExecutor;
	assetId: string;
	waterPurveyorId: string;
	stage: NoticeType;
	runAt: Date;
}): Promise<ScheduledJob> {
	const [row] = await executor
		.insert(scheduledJobs)
		.values({
			jobType: stage,
			bfaAssetId: assetId,
			waterPurveyorId,
			runAt,
			status: "pending",
		})
		.returning();

	if (!row) throw new Error("scheduled_jobs insert returned no row");

	return row;
}

/**
 * Withdraws every live notice job for one asset, and says which it withdrew.
 *
 * `cancelled`, never `failed`: nothing went wrong. A passing test arrived, the
 * due date moved, the feature was switched off, or the assembly no longer has a
 * date to schedule against — all of which are the system being told something,
 * not the system breaking. The distinction is load-bearing for the purveyor
 * reading this table to find out why no notice arrived.
 *
 * `running` rows are cancelled too, not only `pending` ones. A handler mid-send
 * would otherwise finish, schedule its successor, and quietly restart a chain a
 * passing test had just ended; {@link completeRunningJob} is the other half of
 * that race and refuses to complete a row this statement has taken.
 *
 * Returns no rows when there was nothing live, which is the ordinary case and
 * writes nothing at all.
 */
export async function cancelAssetNoticeJobs({
	executor = db,
	assetId,
	reason,
	stages = NOTICE_JOB_TYPES,
}: {
	executor?: JobExecutor;
	assetId: string;
	reason: string;
	stages?: readonly NoticeType[];
}): Promise<ScheduledJob[]> {
	if (stages.length === 0) return [];

	return executor
		.update(scheduledJobs)
		.set({
			status: "cancelled",
			lastError: reason,
			completedAt: new Date(),
		})
		.where(
			and(
				eq(scheduledJobs.bfaAssetId, assetId),
				isLive(),
				inArray(scheduledJobs.jobType, [...stages]),
			),
		)
		.returning();
}

/** The live notice jobs for one asset, in escalation order. */
export async function liveNoticeJobsForAsset({
	executor = db,
	assetId,
}: {
	executor?: JobExecutor;
	assetId: string;
}): Promise<ScheduledJob[]> {
	return executor
		.select()
		.from(scheduledJobs)
		.where(
			and(
				eq(scheduledJobs.bfaAssetId, assetId),
				isLive(),
				inArray(scheduledJobs.jobType, [...NOTICE_JOB_TYPES]),
			),
		)
		.orderBy(asc(scheduledJobs.runAt), asc(scheduledJobs.createdAt));
}

/**
 * Pulls one pending job's `run_at` back to `runAt`, so the next tick claims it.
 *
 * Guarded on `pending` and on the row genuinely being later than where it is
 * being moved to: a job already due needs no help, and writing one anyway would
 * be a no-op update with an audit line attached.
 */
export async function pullJobForward({
	executor = db,
	jobId,
	runAt,
}: {
	executor?: JobExecutor;
	jobId: string;
	runAt: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ runAt, lastError: null })
		.where(
			and(
				eq(scheduledJobs.id, jobId),
				eq(scheduledJobs.status, "pending"),
				sql`${scheduledJobs.runAt} > ${runAt.toISOString()}::timestamptz`,
			),
		)
		.returning();

	return row ?? null;
}

/**
 * Takes ownership of up to `limit` due jobs, moving them `pending → running`.
 *
 * One statement. The inner select locks its candidates with `FOR UPDATE SKIP
 * LOCKED`, so a second process ticking at the same moment skips the rows this
 * one holds instead of blocking on them or claiming them twice; the outer
 * `status = 'pending'` predicate is the same guarantee stated again, for the day
 * somebody changes the locking clause.
 *
 * Oldest first, so a backlog drains in the order the notices were due rather
 * than in whatever order the planner finds convenient.
 *
 * Claiming does not consume an attempt. `attempts` counts failures, and a job
 * picked up and held because its asset has no customer has not failed at
 * anything.
 */
export async function claimDueJobs({
	now,
	limit = CLAIM_BATCH_SIZE,
}: {
	now: Date;
	limit?: number;
}): Promise<ScheduledJob[]> {
	const claimable = db
		.select({ id: scheduledJobs.id })
		.from(scheduledJobs)
		.where(
			and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.runAt, now)),
		)
		.orderBy(asc(scheduledJobs.runAt), asc(scheduledJobs.createdAt))
		.limit(limit)
		.for("update", { skipLocked: true });

	return db
		.update(scheduledJobs)
		.set({ status: "running" })
		.where(
			and(
				inArray(scheduledJobs.id, claimable),
				eq(scheduledJobs.status, "pending"),
			),
		)
		.returning();
}

/**
 * The provider idempotency key for one job: stable for the life of the row, and
 * different for every row.
 *
 * Derived rather than stored, because the job id already is the identity of the
 * one email this job exists to send — a stage of one asset's chain in one cycle.
 * A date change or a new cycle creates a new row and therefore a new key; a
 * retry of the same row never does.
 */
export function noticeIdempotencyKey(jobId: string): string {
	return `bfa-notice/${jobId}`;
}

/**
 * Takes the row lock on one asset for the rest of the caller's transaction.
 *
 * Everything that changes an asset's notice chain — a date correction, a
 * passing test, and a handler completing a stage and scheduling the next — runs
 * this first, so they serialise on the asset rather than interleaving. Without
 * it a date change could commit while a handler's successor insert was still
 * invisible to it, and the successor would survive, computed from the old date.
 */
export async function lockAssetForChain(
	executor: Pick<typeof db, "execute">,
	assetId: string,
): Promise<void> {
	await executor.execute(
		sql`select 1 from bfa_assets where id = ${assetId} for update`,
	);
}

/**
 * Freezes the provider request this job will send — rendered content and sender
 * identity — and starts its delivery window.
 *
 * Written once, before the first provider call, and never rewritten: the
 * provider honours an idempotency key only while the request body is identical,
 * so every retry must replay exactly what was first attempted, including the
 * `from`/`replyTo` that would otherwise be re-read from the environment. `null` means another
 * pass froze a payload first — the caller reads the stored one and sends that.
 */
export async function freezeDelivery({
	executor = db,
	jobId,
	payload,
	at,
}: {
	executor?: JobExecutor;
	jobId: string;
	payload: FrozenEmailPayload;
	at: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ deliveryPayload: payload, deliveryAttemptedAt: at })
		.where(
			and(
				eq(scheduledJobs.id, jobId),
				eq(scheduledJobs.status, "running"),
				isNull(scheduledJobs.deliveryPayload),
				isNull(scheduledJobs.providerMessageId),
			),
		)
		.returning();

	return row ?? null;
}

/** One job, as it is now. */
export async function readJob({
	executor = db,
	jobId,
}: {
	executor?: JobExecutor;
	jobId: string;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.select()
		.from(scheduledJobs)
		.where(eq(scheduledJobs.id, jobId))
		.limit(1);

	return row ?? null;
}

/**
 * Records the provider's confirmation: the message id it returned, and when.
 *
 * The only write that says a notice was delivered, and it happens only after
 * the provider answered with an id. The frozen payload is cleared in the same
 * statement — the delivery is settled, so the rendered message has no reason to
 * stay at rest.
 *
 * Not guarded on `running`. A delivery that the provider confirmed is a fact
 * even when a passing test cancelled the job while the request was in flight,
 * and the record should say so. `provider_message_id is null` keeps the first
 * recorded answer if two passes both reach here.
 */
export async function recordDelivery({
	executor = db,
	jobId,
	providerMessageId,
	at,
}: {
	executor?: JobExecutor;
	jobId: string;
	providerMessageId: string;
	at: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ providerMessageId, deliveredAt: at, deliveryPayload: null })
		.where(
			and(eq(scheduledJobs.id, jobId), isNull(scheduledJobs.providerMessageId)),
		)
		.returning();

	return row ?? null;
}

/**
 * Marks a running job `failed` immediately, without spending retries.
 *
 * For outcomes no retry can fix — today, a delivery whose idempotency window
 * has closed, where a retry could no longer be de-duplicated and the true
 * outcome cannot be learned. Terminal, visible, and explained in `last_error`.
 */
export async function failRunningJob({
	executor = db,
	jobId,
	reason,
	at = new Date(),
}: {
	executor?: JobExecutor;
	jobId: string;
	reason: string;
	at?: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ status: "failed", lastError: reason, completedAt: at })
		.where(
			and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "running")),
		)
		.returning();

	return row ?? null;
}

/**
 * Marks a job `completed`, but only while it is still `running`.
 *
 * The conditional is the point. Between a handler starting and finishing, a
 * passing test or a corrected due date may have cancelled this job; an
 * unconditional completion would put `completed` back over `cancelled` and the
 * handler would then schedule the successor it was cancelled to prevent.
 * Returning `null` is how the handler learns it was superseded.
 */
export async function completeRunningJob({
	executor = db,
	jobId,
}: {
	executor?: JobExecutor;
	jobId: string;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ status: "completed", completedAt: new Date(), lastError: null })
		.where(
			and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "running")),
		)
		.returning();

	return row ?? null;
}

/** Marks a running job `cancelled` with the reason it was withdrawn. */
export async function cancelRunningJob({
	executor = db,
	jobId,
	reason,
}: {
	executor?: JobExecutor;
	jobId: string;
	reason: string;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ status: "cancelled", completedAt: new Date(), lastError: reason })
		.where(
			and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "running")),
		)
		.returning();

	return row ?? null;
}

/**
 * Puts a running job back to `pending` without sending, and records why.
 *
 * The hold. Nothing failed, so `attempts` is untouched and the status is not
 * `failed`; the job simply becomes due again later. `last_error` carries the
 * reason as an explanation for whoever asks why no notice arrived — it is read
 * by people, never by control flow, which is why resuming a held chain is
 * decided from the asset's own dates rather than by matching this string.
 */
export async function holdRunningJob({
	executor = db,
	jobId,
	reason,
	runAt,
}: {
	executor?: JobExecutor;
	jobId: string;
	reason: string;
	runAt: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ status: "pending", runAt, lastError: reason })
		.where(
			and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "running")),
		)
		.returning();

	return row ?? null;
}

/**
 * Puts a job the current build has no handler for back where it was.
 *
 * Not a failure, so no attempt is consumed and the row keeps its retry budget:
 * `ag_renewal` and `fail_list_check` are declared in the `job_type` enum for
 * workflows 2 and 3, and a row of either type must survive being looked at by
 * a build that only knows how to send notices. The reason is recorded so the
 * row does not look like it is quietly stuck.
 */
export async function deferUnhandledJob({
	executor = db,
	jobId,
	reason,
	runAt,
}: {
	executor?: JobExecutor;
	jobId: string;
	reason: string;
	runAt: Date;
}): Promise<ScheduledJob | null> {
	const [row] = await executor
		.update(scheduledJobs)
		.set({ status: "pending", runAt, lastError: reason })
		.where(
			and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "running")),
		)
		.returning();

	return row ?? null;
}

export type RetryOutcome = {
	kind: "retrying" | "failed" | "superseded";
	attempts: number;
	runAt: Date | null;
	job: ScheduledJob | null;
};

/**
 * Records a failed attempt: back to `pending` with a backoff, or `failed` once
 * the ceiling is reached.
 *
 * `attempts` is incremented here and only here, so the number in the row means
 * "times this job failed" rather than "times it was looked at".
 *
 * A job that reaches the ceiling is terminal and schedules nothing. The chain
 * stops there, visibly, with the provider's own message in `last_error` — rather
 * than escalating to a customer who never received the notice before it. That
 * follows the plan's rule that each *successful* notice schedules its successor;
 * it is also the behaviour a purveyor can act on, because a `failed` row is
 * something they can see and ask about.
 *
 * Guarded on `running`, so a job cancelled while the failing attempt was in
 * flight stays cancelled — a passing test that arrived during a provider outage
 * is not undone by the outage being recorded. `superseded` is how the caller
 * learns that happened.
 */
export async function recordJobFailure({
	executor = db,
	job,
	error,
	now = new Date(),
}: {
	executor?: JobExecutor;
	job: ScheduledJob;
	error: string;
	now?: Date;
}): Promise<RetryOutcome> {
	const attempts = job.attempts + 1;
	const exhausted = attempts >= MAX_JOB_ATTEMPTS;
	const runAt = exhausted
		? null
		: new Date(now.getTime() + retryDelayMs(attempts));

	const [row] = await executor
		.update(scheduledJobs)
		.set(
			exhausted
				? {
						status: "failed",
						attempts,
						lastError: error,
						completedAt: now,
					}
				: {
						status: "pending",
						attempts,
						lastError: error,
						runAt: runAt ?? job.runAt,
					},
		)
		.where(
			and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, "running")),
		)
		.returning();

	if (!row)
		return {
			kind: "superseded",
			attempts: job.attempts,
			runAt: null,
			job: null,
		};

	return {
		kind: exhausted ? "failed" : "retrying",
		attempts,
		runAt,
		job: row,
	};
}

/**
 * The `running` rows a previous process died holding.
 *
 * Found by age rather than by a lease column: `scheduled_jobs` already carries a
 * `set_updated_at` trigger, so the moment a row was claimed is recorded without
 * a second timestamp to keep in step. A handler does one template read and one
 * send, so a row still `running` after {@link STALE_RUNNING_AFTER_MS} is not
 * slow, it is abandoned.
 */
export async function staleRunningJobs({
	staleBefore,
}: {
	staleBefore: Date;
}): Promise<ScheduledJob[]> {
	return db
		.select()
		.from(scheduledJobs)
		.where(
			and(
				eq(scheduledJobs.status, "running"),
				lte(scheduledJobs.updatedAt, staleBefore),
			),
		)
		.orderBy(asc(scheduledJobs.runAt));
}
