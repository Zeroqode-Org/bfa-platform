/**
 * Workflow 2's AG rate renewal notice: an annual cycle of one email per
 * agricultural customer, delivered through the scheduler.
 *
 * The water purveyor sets `customers.ag_renewal_date` when it creates an
 * agricultural customer. That date is a Hawaii calendar day, and the notice is
 * one `ag_renewal` job due at the instant that day begins in Pacific/Honolulu
 * (`honoluluDayStart`) — never midnight UTC, which is 14:00 the day before on
 * the islands. The job records which date it is for (`ag_renewal_date`, 0019).
 *
 * The cycle (team-lead decision, superseding the earlier "does not
 * auto-advance" PRD line): after a **provider-confirmed** delivery to an
 * **active** agricultural customer whose date is still the one the notice was
 * for, the handler sets `ag_renewal_date` to **one calendar year after the
 * Hawaii day the delivery was confirmed on** — 29 February becomes 28
 * February in a non-leap year — and queues exactly one next job for it, in
 * the same transaction that completes this one. One job at a time; nothing is
 * pre-created.
 *
 * The year is counted from the confirmed delivery, not from the job's own
 * renewal date, so the customer always gets a full year's notice: a notice
 * that went out late — held for a suspended customer, retried through an
 * outage, or queued from a date the WP entered long in the past — still puts
 * the next one twelve months after the day it actually reached them. The day
 * itself is read from `scheduled_jobs.delivered_at`, which `recordDelivery`
 * wrote with the provider's answer, so a transition that runs later — a
 * retry, or a process recovering a job whose delivery was recorded just
 * before it died — still dates the next notice from the delivery rather than
 * from its own clock. The job's `ag_renewal_date` stays the immutable date of
 * *this* cycle, and is only used to check the WP did not change the date
 * while the notice was in flight.
 *
 * Deliberately *not* an asset notice:
 *
 * - **Customer-scoped.** The job carries `customer_id` and no asset, and the
 *   email goes to the customer's *own* `customers.email` — never through
 *   `bfa_assets.current_customer_id` or `resolveRecipient`.
 * - **No escalation.** The successor is next year's renewal, not a late
 *   notice.
 *
 * Gated on `wp_feature_flags.ag_renewal_notice`, checked when the job *runs*,
 * not when it is queued — the same rule `automated_notices` follows. A
 * missing flag row is off. Off cancels the job: no send, no attempt spent,
 * no date change and no successor.
 *
 * Everything the email says is resolved at send time and frozen once through
 * the shared settlement in `delivery.ts` — the same frozen payload, provider
 * idempotency key, retry, and record-only-from-the-provider rule as every
 * other scheduler email.
 */

import { db } from "@bfa-platform/db";
import type { FrozenEmailPayload } from "@bfa-platform/db/schema";
import {
	customers,
	scheduledJobs,
	waterPurveyors,
	wpFeatureFlags,
} from "@bfa-platform/db/schema";
import { and, eq, sql } from "drizzle-orm";

import { agRenewalNoticeText } from "../lib/ag-renewal-copy";
import type { AuditActor } from "../lib/audit-actor";
import { type EmailDriver, resolveSenderIdentity } from "../lib/email";
import { renderTextEmail } from "../lib/email-layout";
import {
	addCalendarYears,
	type CalendarDay,
	honoluluCalendarDay,
	honoluluDayStart,
} from "../lib/honolulu-dates";
import { type DeliveryPassKind, settleJobDelivery } from "./delivery";
import {
	cancelAgRenewalJobs,
	cancelRunningJob,
	completeRunningJob,
	type JobExecutor,
	liveAgRenewalJobsForCustomer,
	lockCustomerForAgRenewal,
	noticeIdempotencyKey,
	type ScheduledJob,
	scheduleAgRenewalJob,
} from "./jobs";
import { logSchedulerEvent } from "./logging";
import { isPurveyorBlocked } from "./purveyor-status";

/** Why a renewal notice was withdrawn. Read by people in `last_error`. */
export const AG_RENEWAL_CANCEL_REASONS = {
	noCustomer: "An AG renewal notice with no customer on it cannot be sent.",
	noCycleDate:
		"This AG renewal job does not record which renewal date it is for, so it cannot be sent safely.",
	customerGone: "The customer is no longer registered to this water purveyor.",
	notAgricultural:
		"The customer is no longer on the agricultural rate, so there is no AG renewal to send.",
	noRenewalDate:
		"The customer has no AG renewal date, so there is nothing to schedule against.",
	renewalDateChanged:
		"The customer's AG renewal date changed; the notice was rescheduled for the new date.",
	staleRenewalDate:
		"The customer's AG renewal date is no longer the date this notice was queued for.",
	featureDisabled:
		"The AG renewal notice is switched off for this water purveyor.",
} as const;

/** Why a renewal notice is waiting rather than sending. */
export const AG_RENEWAL_HOLD_REASONS = {
	suspendedCustomer:
		"The customer is suspended, which holds their AG renewal notice.",
	noEmail: "The customer has no email address.",
	blockedPurveyor:
		"The water purveyor is blocked, which holds every automated email to its customers.",
} as const;

/**
 * Why a delivered notice completed without moving the date or queueing next
 * year's. Each is a state that changed between the send and the transition —
 * the customer's newer state wins, and the log line says which.
 */
export const AG_RENEWAL_NO_SUCCESSOR_REASONS = {
	customerGone: "customer_gone",
	notAgricultural: "customer_not_agricultural",
	noRenewalDate: "customer_has_no_renewal_date",
	renewalDateChanged: "customer_renewal_date_changed",
	notActive: "customer_not_active",
	/**
	 * The row says a delivery was confirmed but does not say when.
	 * `recordDelivery` writes `provider_message_id` and `delivered_at` in one
	 * statement, so this is unreachable from the code — it is what the
	 * transition does instead of dating next year's notice from a clock: the
	 * job completes (the email did go out) and the cycle stops here, visibly,
	 * for the WP to restart by setting a date.
	 */
	deliveryTimeUnknown: "delivery_time_unknown",
} as const;

/** The instant the renewal notice for `renewalDate` becomes due. */
export function agRenewalRunAt(renewalDate: CalendarDay): Date {
	return honoluluDayStart(renewalDate);
}

/**
 * The renewal date that follows a delivery confirmed on `confirmedDeliveryDay`
 * (a Hawaii calendar day): one calendar year later, 29 February clamped to 28
 * February in a non-leap year.
 *
 * Counted from the delivery rather than from the notice's own renewal date,
 * which is what makes the next notice a full year away however late this one
 * was — and what stops a long-past renewal date from queueing a successor that
 * is itself already overdue. Pure: the caller names the day, and it takes it
 * from the delivery the provider confirmed (`scheduled_jobs.delivered_at`),
 * never from a clock.
 */
export function nextAgRenewalDate(
	confirmedDeliveryDay: CalendarDay,
): CalendarDay {
	return addCalendarYears(confirmedDeliveryDay, 1);
}

/**
 * Brings a customer's renewal notice into line with their current rate and
 * renewal date.
 *
 * Called from customer creation and from an update that changed either field,
 * inside the mutation's own transaction — a customer insert that rolls back
 * must not leave a job behind to mail them. Under the customer's row lock:
 *
 * 1. **Not agricultural, or no date** — every live renewal job is cancelled
 *    with a human-readable reason. Nothing is queued.
 * 2. **Already right** — exactly one live job for exactly this date — is left
 *    alone: no write, no log line.
 * 3. **Otherwise** every live job is cancelled (`pending` *or* `running`: a
 *    running row cancelled here is refused completion, and its handler's
 *    annual transition then moves nothing) and one fresh job is inserted for
 *    the new date. A fresh row is a fresh idempotency key.
 *
 * A date already in the past is scheduled anyway and goes out on the next
 * tick, the same choice the reminder chain makes for a long-overdue assembly.
 */
export async function reconcileAgRenewalNotice({
	executor = db,
	customerId,
	waterPurveyorId,
	rateCategory,
	agRenewalDate,
	actor = null,
	trigger,
}: {
	executor?: JobExecutor;
	customerId: string;
	waterPurveyorId: string;
	rateCategory: "standard" | "agricultural";
	agRenewalDate: CalendarDay | null;
	actor?: AuditActor | null;
	trigger: "customer_created" | "customer_updated";
}): Promise<void> {
	await lockCustomerForAgRenewal(executor, customerId);

	if (rateCategory !== "agricultural" || !agRenewalDate) {
		await withdraw({
			executor,
			customerId,
			waterPurveyorId,
			actor,
			trigger,
			reason:
				rateCategory !== "agricultural"
					? AG_RENEWAL_CANCEL_REASONS.notAgricultural
					: AG_RENEWAL_CANCEL_REASONS.noRenewalDate,
		});

		return;
	}

	const live = await liveAgRenewalJobsForCustomer({ executor, customerId });

	const [only] = live;
	if (live.length === 1 && only?.agRenewalDate === agRenewalDate) {
		return;
	}

	await withdraw({
		executor,
		customerId,
		waterPurveyorId,
		actor,
		trigger,
		reason: AG_RENEWAL_CANCEL_REASONS.renewalDateChanged,
	});

	const scheduled = await scheduleAgRenewalJob({
		executor,
		customerId,
		waterPurveyorId,
		agRenewalDate,
	});

	// `null` only if a concurrent writer inserted the live row first — which
	// the row lock above makes impossible for callers that take it, and which
	// is the idempotent outcome for any that do not.
	if (!scheduled) return;

	logSchedulerEvent("scheduler_job_scheduled", {
		jobId: scheduled.id,
		jobType: scheduled.jobType,
		waterPurveyorId,
		customerId,
		actor,
		extra: {
			trigger,
			ag_renewal_date: agRenewalDate,
			run_at: scheduled.runAt.toISOString(),
			replaced_job_ids: live.map((job) => job.id),
		},
	});
}

async function withdraw({
	executor,
	customerId,
	waterPurveyorId,
	actor,
	trigger,
	reason,
}: {
	executor: JobExecutor;
	customerId: string;
	waterPurveyorId: string;
	actor: AuditActor | null;
	trigger: string;
	reason: string;
}) {
	const cancelled = await cancelAgRenewalJobs({
		executor,
		customerId,
		reason,
	});

	for (const job of cancelled) {
		logSchedulerEvent("scheduler_job_cancelled", {
			jobId: job.id,
			jobType: job.jobType,
			waterPurveyorId,
			customerId,
			actor,
			extra: { reason, trigger },
		});
	}
}

export type AgRenewalOutcome =
	| {
			kind: "sent";
			providerMessageId: string;
			deliveryPass: DeliveryPassKind;
			/** The date the customer moved to, or null when no successor was queued. */
			nextRenewalDate: CalendarDay | null;
	  }
	| { kind: "held"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "delivery_unconfirmed"; reason: string }
	| { kind: "superseded" };

/**
 * The handler behind `ag_renewal` jobs.
 *
 * Re-decides whether to send from current state on every pass, in this order:
 *
 * 1. **The job's own cycle date.** A job that does not record which date it
 *    is for is cancelled rather than guessed at.
 * 2. **The customer**, by the job's `customer_id` *and* its purveyor. Gone or
 *    moved tenant — cancelled.
 * 3. **Still agricultural, still dated, still this date.** A customer whose
 *    date no longer matches the job's is cancelled — the procedures already
 *    withdraw such a job; this catches a row changed outside them.
 * 4. **The feature flag**, `ag_renewal_notice`, read now. Missing or off is
 *    cancelled without sending and without spending an attempt.
 * 5. **The delivery**, through the shared settlement, to the customer's own
 *    email. Suspended or email-less holds the job, as every notice does.
 * 6. **The annual transition** ({@link completeAgRenewalCycle}), only after
 *    the provider confirmed.
 *
 * Steps 1–4 run on every pass, including a retry that will replay a frozen
 * payload and one that finds the delivery already recorded.
 */
export async function runAgRenewalJob(
	job: ScheduledJob,
	{ now = new Date(), driver }: { now?: Date; driver?: EmailDriver } = {},
): Promise<AgRenewalOutcome> {
	if (!job.customerId) {
		return cancel(job, AG_RENEWAL_CANCEL_REASONS.noCustomer);
	}

	const cycleDate = job.agRenewalDate;

	if (!cycleDate) {
		return cancel(job, AG_RENEWAL_CANCEL_REASONS.noCycleDate);
	}

	const [customer] = await db
		.select({
			id: customers.id,
			waterPurveyorId: customers.waterPurveyorId,
			name: customers.name,
			email: customers.email,
			status: customers.status,
			rateCategory: customers.rateCategory,
			agRenewalDate: customers.agRenewalDate,
		})
		.from(customers)
		.where(
			and(
				eq(customers.id, job.customerId),
				eq(customers.waterPurveyorId, job.waterPurveyorId),
			),
		)
		.limit(1);

	if (!customer) return cancel(job, AG_RENEWAL_CANCEL_REASONS.customerGone);

	if (customer.rateCategory !== "agricultural") {
		return cancel(job, AG_RENEWAL_CANCEL_REASONS.notAgricultural);
	}

	if (!customer.agRenewalDate) {
		return cancel(job, AG_RENEWAL_CANCEL_REASONS.noRenewalDate);
	}

	if (customer.agRenewalDate !== cycleDate) {
		return cancel(job, AG_RENEWAL_CANCEL_REASONS.staleRenewalDate);
	}

	if (!(await agRenewalNoticeEnabled(customer.waterPurveyorId))) {
		return cancel(job, AG_RENEWAL_CANCEL_REASONS.featureDisabled);
	}

	const settlement = await settleJobDelivery<RenderedAgRenewal>({
		job,
		jobType: "ag_renewal",
		emailEvent: "ag_renewal",
		assetId: null,
		waterPurveyorId: customer.waterPurveyorId,
		now,
		driver,
		render: async () => {
			// A blocked purveyor holds this email too — see `isPurveyorBlocked`.
			if (await isPurveyorBlocked(customer.waterPurveyorId)) {
				return { hold: AG_RENEWAL_HOLD_REASONS.blockedPurveyor };
			}
			if (customer.status === "suspended") {
				return { hold: AG_RENEWAL_HOLD_REASONS.suspendedCustomer };
			}
			if (!customer.email.trim()) {
				return { hold: AG_RENEWAL_HOLD_REASONS.noEmail };
			}

			return renderAgRenewal(customer, cycleDate, driver);
		},
	});

	// Held, superseded, or an outcome the provider never confirmed: nothing
	// below runs. No date moves on a guess.
	if (settlement.kind !== "delivered") return settlement;

	const transition = await completeAgRenewalCycle({
		job,
		customerId: customer.id,
		waterPurveyorId: job.waterPurveyorId,
		cycleDate,
	});

	const idempotencyKey = noticeIdempotencyKey(job.id);

	if (transition.kind === "superseded") {
		logSchedulerEvent("scheduler_job_superseded", {
			jobId: job.id,
			jobType: "ag_renewal",
			waterPurveyorId: job.waterPurveyorId,
			customerId: customer.id,
			extra: {
				reason:
					"The job was no longer running when its delivery settled; the renewal date was not moved and no successor was scheduled.",
				idempotency_key: idempotencyKey,
				provider_message_id: settlement.providerMessageId,
			},
		});

		return { kind: "superseded" };
	}

	if (transition.kind === "advanced") {
		logSchedulerEvent("scheduler_job_scheduled", {
			jobId: transition.successor.id,
			jobType: "ag_renewal",
			waterPurveyorId: job.waterPurveyorId,
			customerId: customer.id,
			extra: {
				trigger: "ag_renewal_annual_cycle",
				ag_renewal_date: transition.nextDate,
				run_at: transition.successor.runAt.toISOString(),
				previous_job_id: job.id,
			},
		});
	}

	logSchedulerEvent("scheduler_job_completed", {
		jobId: job.id,
		jobType: "ag_renewal",
		waterPurveyorId: job.waterPurveyorId,
		customerId: settlement.recipientId ?? customer.id,
		extra: {
			idempotency_key: idempotencyKey,
			provider_message_id: settlement.providerMessageId,
			delivery_pass: settlement.pass,
			previous_ag_renewal_date: cycleDate,
			next_ag_renewal_date:
				transition.kind === "advanced" ? transition.nextDate : null,
			next_job_id:
				transition.kind === "advanced" ? transition.successor.id : null,
			next_run_at:
				transition.kind === "advanced"
					? transition.successor.runAt.toISOString()
					: null,
			no_successor_reason:
				transition.kind === "completed_without_successor"
					? transition.reason
					: null,
		},
	});

	return {
		kind: "sent",
		providerMessageId: settlement.providerMessageId,
		deliveryPass: settlement.pass,
		nextRenewalDate:
			transition.kind === "advanced" ? transition.nextDate : null,
	};
}

type CycleTransition =
	| { kind: "advanced"; nextDate: CalendarDay; successor: ScheduledJob }
	| { kind: "completed_without_successor"; reason: string }
	| { kind: "superseded" };

/**
 * The annual transition: completes a delivered job and, when the customer
 * still qualifies, moves their date one year on and queues next year's job —
 * all in one transaction, or none of it.
 *
 * Locks the customer row first and the job row second — the same order
 * `reconcileAgRenewalNotice` takes (customer lock, then its job writes) — so
 * a WP save and this transition serialise instead of deadlocking. Then:
 *
 * 1. **The job must still be `running`.** A date or rate change that
 *    cancelled it during the send wins: nothing moves, nothing is queued.
 *    This is also what a second pass over the same job finds after the first
 *    committed — `completed` — so it cannot add a second year.
 * 2. **The customer must still be this purveyor's, agricultural, `active`,
 *    and dated exactly `cycleDate`** — the date recorded on the job. If any of
 *    that changed since the send, the newer state wins: the job is completed
 *    (the email did go out) and the reason is returned for the log.
 * 3. Otherwise the date moves to {@link nextAgRenewalDate} — one year after
 *    the Hawaii day of the *recorded* delivery — `revision` is bumped so a
 *    form opened before this cannot put the old date back, the job completes,
 *    and exactly one pending job for the new date is inserted. The customer
 *    update is also conditional on the old date, so even a writer that skipped
 *    the lock could not have its date overwritten.
 *
 * The day comes from `scheduled_jobs.delivered_at`, read under the same lock,
 * and from nothing else. `recordDelivery` writes it with the provider's answer
 * and never rewrites it, so a pass that picks this job up later — a retry, or
 * a process recovering a job whose delivery was recorded just before it died —
 * dates next year's notice from when the customer was actually written to,
 * not from when the transition happened to run. Using the handler's `now`
 * would move the date by a day whenever those two fall either side of Hawaii
 * midnight. A confirmed delivery with no `delivered_at` is not guessed at: the
 * job completes with no successor and says why.
 *
 * Throws (and rolls back everything) if the successor insert finds a live job
 * already there — impossible under the lock, and a retry is the right answer
 * if it ever happens: the delivery is recorded, so the retry sends nothing.
 */
async function completeAgRenewalCycle({
	job,
	customerId,
	waterPurveyorId,
	cycleDate,
}: {
	job: ScheduledJob;
	customerId: string;
	waterPurveyorId: string;
	/** The renewal date this job was queued for — `scheduled_jobs.ag_renewal_date`. */
	cycleDate: CalendarDay;
}): Promise<CycleTransition> {
	return db.transaction(async (tx) => {
		const [customer] = await tx
			.select({
				waterPurveyorId: customers.waterPurveyorId,
				rateCategory: customers.rateCategory,
				agRenewalDate: customers.agRenewalDate,
				status: customers.status,
			})
			.from(customers)
			.where(eq(customers.id, customerId))
			.limit(1)
			.for("update");

		const [current] = await tx
			.select({
				status: scheduledJobs.status,
				// The provider's own confirmation time, not this pass's clock.
				deliveredAt: scheduledJobs.deliveredAt,
			})
			.from(scheduledJobs)
			.where(eq(scheduledJobs.id, job.id))
			.limit(1)
			.for("update");

		if (current?.status !== "running") return { kind: "superseded" };

		const reason =
			!customer || customer.waterPurveyorId !== waterPurveyorId
				? AG_RENEWAL_NO_SUCCESSOR_REASONS.customerGone
				: customer.rateCategory !== "agricultural"
					? AG_RENEWAL_NO_SUCCESSOR_REASONS.notAgricultural
					: !customer.agRenewalDate
						? AG_RENEWAL_NO_SUCCESSOR_REASONS.noRenewalDate
						: customer.agRenewalDate !== cycleDate
							? AG_RENEWAL_NO_SUCCESSOR_REASONS.renewalDateChanged
							: customer.status !== "active"
								? AG_RENEWAL_NO_SUCCESSOR_REASONS.notActive
								: !current.deliveredAt
									? AG_RENEWAL_NO_SUCCESSOR_REASONS.deliveryTimeUnknown
									: null;

		if (reason) {
			await completeRunningJob({ executor: tx, jobId: job.id });

			return { kind: "completed_without_successor", reason };
		}

		// Non-null: the branch above returns without a successor when it is not.
		const deliveredAt = current.deliveredAt as Date;
		const nextDate = nextAgRenewalDate(honoluluCalendarDay(deliveredAt));

		// `revision + 1` in the same conditional statement as the date: a WP form
		// opened before this transition carries the old revision, and
		// `updateCustomer` refuses it rather than writing the old date back over
		// the cycle this just started.
		const [moved] = await tx
			.update(customers)
			.set({
				agRenewalDate: nextDate,
				revision: sql`${customers.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(customers.id, customerId),
					eq(customers.waterPurveyorId, waterPurveyorId),
					eq(customers.agRenewalDate, cycleDate),
				),
			)
			.returning({ id: customers.id });

		if (!moved) {
			// Unreachable under the row lock; stated so the transition can never
			// queue a successor without the date having moved with it.
			throw new Error(
				`AG renewal date for customer ${customerId} changed under the lock`,
			);
		}

		// Completed before the insert: the live-customer index (0018) allows one
		// live job, and this one stops being live here.
		await completeRunningJob({ executor: tx, jobId: job.id });

		const successor = await scheduleAgRenewalJob({
			executor: tx,
			customerId,
			waterPurveyorId,
			agRenewalDate: nextDate,
		});

		if (!successor) {
			throw new Error(
				`A live AG renewal job already exists for customer ${customerId}`,
			);
		}

		return { kind: "advanced", nextDate, successor };
	});
}

type RenderedAgRenewal = { payload: FrozenEmailPayload };

/** The renewal email, rendered once and frozen, addressed to the customer. */
async function renderAgRenewal(
	customer: {
		id: string;
		waterPurveyorId: string;
		name: string;
		email: string;
	},
	renewalDate: CalendarDay,
	driver: EmailDriver | undefined,
): Promise<RenderedAgRenewal> {
	const sender = await resolveSenderIdentity(driver);
	const wpName = await purveyorName(customer.waterPurveyorId);

	const { subject, text } = agRenewalNoticeText({
		customerName: customer.name,
		wpName,
		renewalDate,
	});

	return {
		payload: {
			to: customer.email,
			subject,
			html: renderTextEmail({ subject, text }),
			tags: [
				{ name: "type", value: "ag_renewal" },
				{ name: "wp_id", value: customer.waterPurveyorId },
				{ name: "customer_id", value: customer.id },
			],
			sender,
			recipientId: customer.id,
		},
	};
}

/**
 * Whether this purveyor has the `ag_renewal_notice` add-on switched on. A
 * missing row is off — an optional paid add-on is never on by default.
 */
async function agRenewalNoticeEnabled(
	waterPurveyorId: string,
): Promise<boolean> {
	const [flag] = await db
		.select({ isEnabled: wpFeatureFlags.isEnabled })
		.from(wpFeatureFlags)
		.where(
			and(
				eq(wpFeatureFlags.waterPurveyorId, waterPurveyorId),
				eq(wpFeatureFlags.feature, "ag_renewal_notice"),
			),
		)
		.limit(1);

	return flag?.isEnabled === true;
}

/** The purveyor's own name for the greeting and sign-off. */
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
	reason: string,
): Promise<AgRenewalOutcome> {
	const cancelled = await cancelRunningJob({ jobId: job.id, reason });

	if (!cancelled) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_cancelled", {
		jobId: job.id,
		jobType: "ag_renewal",
		waterPurveyorId: job.waterPurveyorId,
		customerId: job.customerId,
		extra: { reason, trigger: "job_execution" },
	});

	return { kind: "cancelled", reason };
}
