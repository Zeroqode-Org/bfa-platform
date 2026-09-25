import { sql } from "drizzle-orm";
import {
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

import { bfaAssets } from "./bfa-assets";
import { customers } from "./customers";
import { jobStatus, jobType } from "./enums";
import { testSubmissions } from "./test-submissions";
import { waterPurveyors } from "./water-purveyors";

/**
 * Everything the provider sees in a message's request body, as it was fixed
 * before the first attempt. Stored so every retry sends a body identical to the
 * original request, which the provider requires before it will honour an
 * idempotency key: the rendered content *and* the sender identity, which would
 * otherwise be re-read from the environment on each attempt.
 */
export type FrozenEmailPayload = {
	to: string;
	subject: string;
	html: string;
	tags: { name: string; value: string }[];
	/**
	 * `from` and `replyTo` as configured at the first attempt. Every payload this
	 * version freezes has the key; its three states mean different things and
	 * must never be collapsed:
	 *
	 * - `{ from, replyTo }` — pinned; every retry sends exactly this sender.
	 * - `null` — frozen under a driver with no sender to pin (the console
	 *   driver). Safe to replay.
	 * - **key absent** — a legacy row, frozen by the earlier version that did not
	 *   store the sender. The first request's sender is unknown, so the request
	 *   cannot be replayed identically; the handler fails such a job as
	 *   *delivery outcome unknown* instead of sending. It is *not* read as `null`.
	 *
	 * Optional in the type only to describe those legacy rows. Tell the states
	 * apart with `Object.hasOwn(payload, "sender")`, not with `?? null`.
	 */
	sender?: { from: string; replyTo: string } | null;
	/** The customer it was rendered for. For the delivery log; never sent. */
	recipientId: string;
};

// Not in the original data model. Required because Vercel Cron is off the
// table (bfa-requirements) and job state must survive restarts. All writes
// go through the service-role scheduler process — no user-facing write path.
export const scheduledJobs = pgTable(
	"scheduled_jobs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		jobType: jobType("job_type").notNull(),
		bfaAssetId: uuid("bfa_asset_id").references(() => bfaAssets.id),
		customerId: uuid("customer_id").references(() => customers.id),
		// The submitted test a `failure_notice` job answers. Deliberately *instead
		// of* `bfa_asset_id` on those rows: the live-asset index below allows only
		// one live job per (asset, type), and two failing submissions for one
		// assembly in quick succession are two failure notices, not one. The
		// handler resolves the asset — and everything else — from the submission
		// at send time.
		testSubmissionId: uuid("test_submission_id").references(
			() => testSubmissions.id,
		),
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		// The `customers.ag_renewal_date` an `ag_renewal` job was queued for
		// (0019). Written once at insert, never rewritten: a changed date cancels
		// the job and inserts a fresh one. The annual transition advances the
		// customer's date only while it still equals this value, which is what
		// stops a retry from adding a second year. NULL on every other job type.
		agRenewalDate: date("ag_renewal_date"),
		runAt: timestamp("run_at", { withTimezone: true }).notNull(),
		status: jobStatus("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		// The delivery outcome — see 0013, which replaced 0012's `sent_at`.
		// The whole provider request body — rendered content and sender
		// identity — frozen before the first send attempt so every retry replays
		// it unchanged under the job's idempotency key. Cleared once the outcome
		// is recorded. See `FrozenEmailPayload`.
		deliveryPayload: jsonb("delivery_payload").$type<FrozenEmailPayload>(),
		// The first attempt — the start of the provider's 24-hour
		// de-duplication window.
		deliveryAttemptedAt: timestamp("delivery_attempted_at", {
			withTimezone: true,
		}),
		// Written only after the provider confirms acceptance. The only
		// evidence of delivery this table holds.
		providerMessageId: text("provider_message_id"),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("scheduled_jobs_water_purveyor_id_idx").on(table.waterPurveyorId),
		// the scheduler's claim query
		index("scheduled_jobs_status_run_at_idx").on(table.status, table.runAt),
		// One live job per stage per assembly. A notice chain is derived entirely
		// from the asset's annual_test_date, so two pending reminders for one
		// asset are two copies of the same reminder and would both fire; two
		// clerks saving a date change at once is enough to create them. Partial
		// on the non-terminal statuses so a completed stage and next cycle's
		// pending one coexist, and on `bfa_asset_id is not null` so the
		// customer-scoped ag_renewal job is not squeezed into an asset-shaped
		// rule. Doubles as the lookup index for cancelling an asset's chain.
		uniqueIndex("scheduled_jobs_live_asset_job_type_key")
			.on(table.bfaAssetId, table.jobType)
			.where(
				sql`${table.status} in ('pending', 'running') and ${table.bfaAssetId} is not null`,
			),
		// At most one job per (submission, type) that has not been *cancelled* —
		// pending, running, completed and failed all conflict. Stricter than the
		// live-asset rule above on purpose: a failure notice answers one submitted
		// failing test, and a correction that touches the row again must not queue
		// a second email for a fail the customer was already told about. Only a
		// cancellation — the fail was corrected away — frees the slot, so a WP
		// that corrects a result to pass and then back to fail gets exactly one
		// fresh notice. Doubles as the lookup index for a submission's jobs.
		uniqueIndex("scheduled_jobs_settled_submission_job_type_key")
			.on(table.testSubmissionId, table.jobType)
			.where(
				sql`${table.testSubmissionId} is not null and ${table.status} <> 'cancelled'`,
			),
		// One live job per type per customer — the customer-scoped counterpart of
		// the live-asset rule (0018). The AG renewal notice is derived entirely
		// from `customers.ag_renewal_date`, so two live rows for one customer are
		// two copies of one email. Partial on the live statuses so a completed
		// notice and a later cycle's pending one coexist. Doubles as the lookup
		// index for a customer's live jobs.
		uniqueIndex("scheduled_jobs_live_customer_job_type_key")
			.on(table.customerId, table.jobType)
			.where(
				sql`${table.status} in ('pending', 'running') and ${table.customerId} is not null`,
			),
		check(
			"scheduled_jobs_ag_renewal_date_only_on_ag_jobs",
			sql`${table.agRenewalDate} is null or ${table.jobType} = 'ag_renewal'`,
		),
	],
).enableRLS();
