/**
 * The scheduler's structured log vocabulary.
 *
 * Every line is one JSON object on one `console.log`, in the same shape the
 * feature routers emit (`actor_id`, `effective_profile_id`, `wp_id`,
 * `asset_id`, `timestamp`) — the project requirement is that a sensitive write
 * is greppable by tenant, and the scheduler's writes are the ones with no human
 * behind them, which makes the log the only account of what happened.
 *
 * `actor_id` and `effective_profile_id` are null on a line the loop produced by
 * itself, and carry the acting profile on a line a purveyor's own save caused —
 * scheduling a reminder after an asset's date is corrected is that person's
 * action as much as the row they edited.
 *
 * The event names are a closed list so that a dashboard or a `grep` can rely on
 * them, and so a new call site cannot invent a third spelling of "cancelled".
 */

import { type AuditActor, auditActorFields } from "../lib/audit-actor";

export const SCHEDULER_EVENTS = {
	/** A job row was created — a new asset's reminder, or a date change's replacement. */
	scheduled: "scheduler_job_scheduled",
	/** A pending job was withdrawn: passing test, changed date, flag off, gone asset. */
	cancelled: "scheduler_job_cancelled",
	/** A pending job that was already due was pulled forward to run now. */
	resumed: "scheduler_job_resumed",
	/** The loop took ownership of a due job. */
	claimed: "scheduler_job_claimed",
	/**
	 * The provider confirmed the job's email and the confirmation is on record.
	 * Carries the job id, the idempotency key and the provider's message id —
	 * the three values that tie a job to a delivery in the provider's own log —
	 * and nothing about the recipient beyond their customer id.
	 */
	deliveryRecorded: "scheduler_delivery_recorded",
	/**
	 * The first attempt is older than the provider's idempotency window, so the
	 * outcome can no longer be learned without risking a duplicate. The job is
	 * failed for a person to resolve. Terminal.
	 */
	deliveryUnconfirmed: "scheduler_delivery_unconfirmed",
	/** The job did what it exists to do. */
	completed: "scheduler_job_completed",
	/** Nothing was sent and the chain did not advance; the job stays pending. */
	held: "scheduler_job_held",
	/** A delivery failed and the job will be tried again. */
	retrying: "scheduler_job_retrying",
	/** The attempt ceiling was reached. Terminal. */
	failed: "scheduler_job_failed",
	/** A `running` row left behind by a crash was reclaimed. */
	recovered: "scheduler_job_recovered",
	/** The job was cancelled underneath a handler that was already running it. */
	superseded: "scheduler_job_superseded",
	/** One pass of the loop, with what it did. */
	tick: "scheduler_tick",
	/** The loop started, and what startup reconciliation found. */
	started: "scheduler_started",
	/** The loop stopped. */
	stopped: "scheduler_stopped",
	/** `bfa_assets.asset_status` was recomputed from `annual_test_date`. */
	assetStatusRecomputed: "scheduler_asset_status_recomputed",
} as const;

export type SchedulerEvent =
	(typeof SCHEDULER_EVENTS)[keyof typeof SCHEDULER_EVENTS];

export type SchedulerLogFields = {
	jobId?: string | null;
	jobType?: string | null;
	assetId?: string | null;
	waterPurveyorId?: string | null;
	customerId?: string | null;
	actor?: AuditActor | null;
	/** Anything else this event carries. Snake_case keys, to match the line. */
	extra?: Record<string, unknown>;
};

export function logSchedulerEvent(
	event: SchedulerEvent,
	{
		jobId,
		jobType,
		assetId,
		waterPurveyorId,
		customerId,
		actor,
		extra,
	}: SchedulerLogFields = {},
) {
	console.log(
		JSON.stringify({
			event,
			...auditActorFields(actor),
			job_id: jobId ?? null,
			job_type: jobType ?? null,
			asset_id: assetId ?? null,
			wp_id: waterPurveyorId ?? null,
			customer_id: customerId ?? null,
			...extra,
			timestamp: new Date().toISOString(),
		}),
	);
}
