/**
 * The one way a claimed job's email gets delivered.
 *
 * Extracted from the notice handler when the failure notice arrived, because
 * this sequence *is* the delivery guarantee and two copies of it would be two
 * chances to break it. What it owns, for any job whose work is one email:
 *
 * 1. **The row as it is now**, not as it was claimed — a previous pass may
 *    already have frozen a payload or recorded the provider's answer before it
 *    died, and a job withdrawn after its claim must send nothing.
 * 2. **Render once, freeze once.** On the first attempt the caller's `render`
 *    decides the recipient and the words *now*; the result — content and
 *    sender identity, the provider's whole request body — is frozen on the row
 *    before the first provider call, and every later attempt replays exactly
 *    that. A render may instead ask for a hold (no recipient), which puts the
 *    row back to `pending` without consuming an attempt.
 * 3. **The send**, through `sendEmail` under the job's own idempotency key, so
 *    the provider sends at most one email however many attempts reach it.
 * 4. **The outcome**, recorded only from the provider's answer. A crash
 *    between acceptance and the record is recovered by asking again with the
 *    same key; a retry past the provider's de-duplication window — or a legacy
 *    payload whose sender was never frozen — fails explicitly as *delivery
 *    outcome unknown* rather than guessing.
 *
 * What it deliberately does not own: deciding whether the job should run at
 * all (tenancy, flags, the fact the notice answers), and what happens after a
 * confirmed delivery (completing the row, scheduling a successor). Those are
 * the handlers'.
 */

import type { FrozenEmailPayload } from "@bfa-platform/db/schema";

import { type EmailDriver, type EmailSender, sendEmail } from "../lib/email";
import { PROVIDER_IDEMPOTENCY_WINDOW_MS, RECIPIENT_HOLD_MS } from "./config";
import {
	failRunningJob,
	freezeDelivery,
	holdRunningJob,
	noticeIdempotencyKey,
	readJob,
	recordDelivery,
	type ScheduledJob,
} from "./jobs";
import { logSchedulerEvent } from "./logging";

/** How this pass reached a confirmed delivery. */
export type DeliveryPassKind =
	| "first_attempt"
	| "idempotent_retry"
	| "already_recorded";

/**
 * What settling a job's delivery produced.
 *
 * `delivered` is the only branch a handler advances on. `rendered` carries the
 * caller's own render result when this pass was the one that rendered, and
 * `null` on a replay; `recipientId` is from whichever payload was actually
 * used, for the completion log.
 */
export type DeliverySettlement<R extends { payload: FrozenEmailPayload }> =
	| {
			kind: "delivered";
			providerMessageId: string;
			pass: DeliveryPassKind;
			rendered: R | null;
			recipientId: string | null;
	  }
	| { kind: "held"; reason: string }
	| { kind: "superseded" }
	| { kind: "delivery_unconfirmed"; reason: string };

/**
 * What a frozen payload says about its sender, told apart by whether the JSON
 * object *has* a `sender` key — never by collapsing absent and `null`:
 *
 * - `pinned` — `{ from, replyTo }` frozen before the first provider call.
 * - `none` — an explicit `null`: frozen under a driver with no sender to pin.
 *   Safe to replay; the driver supplies its own.
 * - `legacy` — no key at all: frozen by the version of the notice handler that
 *   did not store the sender. The first request's sender is unknowable.
 */
type FrozenSender =
	| { kind: "pinned"; sender: EmailSender }
	| { kind: "none" }
	| { kind: "legacy" };

function frozenSender(payload: FrozenEmailPayload): FrozenSender {
	if (!Object.hasOwn(payload, "sender")) return { kind: "legacy" };

	const { sender } = payload;

	return sender ? { kind: "pinned", sender } : { kind: "none" };
}

const UNCONFIRMED_REASONS = {
	idempotency_window_expired:
		"Delivery outcome unknown: the first send attempt is older than the provider's 24-hour idempotency window, so a retry could send a duplicate. Check the provider's log for this idempotency key before resending.",
	legacy_sender_not_frozen:
		"Delivery outcome unknown: this job's payload was frozen by an earlier version that did not store the sender identity (from / reply-to) of its first provider request, so that request cannot be replayed identically and a safe retry is impossible. Check the provider's log for this idempotency key before resending.",
} as const;

export async function settleJobDelivery<
	R extends { payload: FrozenEmailPayload },
>({
	job,
	jobType,
	emailEvent,
	assetId,
	waterPurveyorId,
	render,
	now,
	driver,
}: {
	job: ScheduledJob;
	/** For the log lines. The job row's own type, spelled by the handler. */
	jobType: string;
	/** The `email_send_attempted` line's `email_event`, e.g. `notice_reminder`. */
	emailEvent: string;
	/** The assembly this delivery is about, resolved by the handler. */
	assetId: string | null;
	waterPurveyorId: string;
	/**
	 * Decides the recipient and renders the message, called at most once and
	 * only when no payload is frozen yet. `{ hold: reason }` parks the job
	 * instead of sending — a recipient that does not exist yet is not a failure.
	 */
	render: () => Promise<{ hold: string } | R>;
	now: Date;
	driver?: EmailDriver;
}): Promise<DeliverySettlement<R>> {
	const idempotencyKey = noticeIdempotencyKey(job.id);

	// The row as it is now, not as it was claimed. A previous pass may already
	// have frozen a payload or recorded the provider's answer before it died.
	const current = await readJob({ jobId: job.id });

	if (current?.status !== "running") {
		return superseded(
			job,
			jobType,
			assetId,
			idempotencyKey,
			"The job was cancelled before its send.",
		);
	}

	let rendered: R | null = null;
	let settled: ScheduledJob = current;

	if (!settled.providerMessageId && !settled.deliveryPayload) {
		// First attempt: decide the recipient and the words *now*, then freeze
		// them. Everything after this replays the frozen message.
		const outcome = await render();

		if ("hold" in outcome) {
			return hold(job, jobType, assetId, waterPurveyorId, outcome.hold, now);
		}

		rendered = outcome;

		const frozen = await freezeDelivery({
			jobId: job.id,
			payload: rendered.payload,
			at: now,
		});

		if (frozen) {
			settled = frozen;
		} else {
			// Another pass froze first — and may already have sent and recorded
			// the outcome — or the row stopped being ours. Whatever it froze is
			// what gets sent, never a second rendering.
			const again = await readJob({ jobId: job.id });

			if (again?.status !== "running") {
				return superseded(
					job,
					jobType,
					assetId,
					idempotencyKey,
					"The job was cancelled before its send.",
				);
			}

			settled = again;
			rendered = null;
		}
	}

	if (settled.providerMessageId) {
		// The provider's confirmation is already on record — from an earlier pass
		// whose completion was lost, or from a concurrent pass that got there
		// first. Nothing is sent; the handler simply advances.
		return {
			kind: "delivered",
			providerMessageId: settled.providerMessageId,
			pass: "already_recorded",
			rendered,
			recipientId: settled.deliveryPayload?.recipientId ?? null,
		};
	}

	const payload = settled.deliveryPayload;
	const attemptedAt = settled.deliveryAttemptedAt;
	const pass: DeliveryPassKind = rendered
		? "first_attempt"
		: "idempotent_retry";

	if (!payload || !attemptedAt) {
		// Every path above ends with a recorded id or a frozen payload. A row
		// with neither is broken, and sending anything for it would be a guess.
		throw new Error(`Job ${job.id} has no frozen delivery payload to send.`);
	}

	const sender = frozenSender(payload);

	// A payload frozen by the pre-0013 notice handler has no `sender` key at
	// all: the `from` and `replyTo` of its first provider request were read from
	// the environment and never stored. That request may have been accepted with
	// its response lost, and the request body cannot be rebuilt, so any replay
	// risks a 409 under the key or — if sent as the current sender — a body that
	// was never the original. This does not depend on age: a legacy row is
	// unsafe to replay a minute later.
	if (sender.kind === "legacy") {
		return deliveryUnconfirmed(
			job,
			jobType,
			assetId,
			waterPurveyorId,
			idempotencyKey,
			attemptedAt,
			"legacy_sender_not_frozen",
		);
	}

	// Outside the provider's de-duplication window a replay could send a second
	// email, and the true outcome of the first attempt can no longer be learned.
	// Neither guessing "delivered" nor guessing "not delivered" is acceptable,
	// so the job fails, visibly, for a person to resolve.
	if (
		pass === "idempotent_retry" &&
		now.getTime() - attemptedAt.getTime() > PROVIDER_IDEMPOTENCY_WINDOW_MS
	) {
		return deliveryUnconfirmed(
			job,
			jobType,
			assetId,
			waterPurveyorId,
			idempotencyKey,
			attemptedAt,
			"idempotency_window_expired",
		);
	}

	// The one shared send path. The frozen payload is replayed exactly, with
	// the job's key, so the provider sends at most one email for this job no
	// matter how many attempts reach this line. A refusal throws, the payload
	// stays frozen, and the loop's retry policy re-queues the job — with no
	// completion, because nothing has been confirmed.
	const result = await sendEmail(
		{
			to: payload.to,
			subject: payload.subject,
			html: payload.html,
			tags: payload.tags,
			// The sender fixed at the first attempt — never the environment's
			// current one — so this body is the first attempt's body. An explicit
			// `null` was frozen under a driver with no sender to pin (the console
			// driver); it leaves the driver to use its own configuration, which
			// then makes the first request any provider sees under this key. A
			// *missing* key never reaches here — see the legacy check above.
			sender: sender.kind === "pinned" ? sender.sender : null,
			idempotencyKey,
		},
		{
			event: emailEvent,
			recipientId: payload.recipientId,
			wpId: waterPurveyorId,
			assetId,
		},
		driver,
	);

	// Durable before anything depends on it. The handler advances only after
	// this commit, so a crash from here on is recovered by the
	// `already_recorded` branch rather than by another send.
	await recordDelivery({
		jobId: job.id,
		providerMessageId: result.id,
		at: now,
	});

	logSchedulerEvent("scheduler_delivery_recorded", {
		jobId: job.id,
		jobType,
		assetId,
		waterPurveyorId,
		customerId: payload.recipientId,
		extra: {
			idempotency_key: idempotencyKey,
			provider_message_id: result.id,
			driver: result.driver,
			delivery_pass: pass,
		},
	});

	return {
		kind: "delivered",
		providerMessageId: result.id,
		pass,
		rendered,
		recipientId: payload.recipientId,
	};
}

/**
 * Ends a job whose first attempt cannot be safely replayed, without sending:
 * its attempt is older than the provider's de-duplication window, or its
 * payload predates the frozen sender identity.
 */
async function deliveryUnconfirmed<R extends { payload: FrozenEmailPayload }>(
	job: ScheduledJob,
	jobType: string,
	assetId: string | null,
	waterPurveyorId: string,
	idempotencyKey: string,
	attemptedAt: Date,
	cause: keyof typeof UNCONFIRMED_REASONS,
): Promise<DeliverySettlement<R>> {
	const reason = UNCONFIRMED_REASONS[cause];
	const failed = await failRunningJob({ jobId: job.id, reason });

	if (!failed) return { kind: "superseded" };

	logSchedulerEvent("scheduler_delivery_unconfirmed", {
		jobId: job.id,
		jobType,
		assetId,
		waterPurveyorId,
		extra: {
			idempotency_key: idempotencyKey,
			delivery_attempted_at: attemptedAt.toISOString(),
			cause,
			reason,
		},
	});

	return { kind: "delivery_unconfirmed", reason };
}

async function superseded<R extends { payload: FrozenEmailPayload }>(
	job: ScheduledJob,
	jobType: string,
	// The handler's resolved asset, not `job.bfaAssetId`: a failure-notice row
	// deliberately carries no asset of its own, and the log line should still
	// name the assembly the withdrawn send was about.
	assetId: string | null,
	idempotencyKey: string,
	reason: string,
): Promise<DeliverySettlement<R>> {
	logSchedulerEvent("scheduler_job_superseded", {
		jobId: job.id,
		jobType,
		assetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: { reason, idempotency_key: idempotencyKey },
	});

	return { kind: "superseded" };
}

async function hold<R extends { payload: FrozenEmailPayload }>(
	job: ScheduledJob,
	jobType: string,
	assetId: string | null,
	waterPurveyorId: string,
	reason: string,
	now: Date,
): Promise<DeliverySettlement<R>> {
	const runAt = new Date(now.getTime() + RECIPIENT_HOLD_MS);
	const held = await holdRunningJob({ jobId: job.id, reason, runAt });

	if (!held) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_held", {
		jobId: job.id,
		jobType,
		assetId,
		waterPurveyorId,
		extra: { reason, held_until: runAt.toISOString() },
	});

	return { kind: "held", reason };
}
