/**
 * The handler behind all four notice stages.
 *
 * One function, not four. The stages differ in exactly three ways — which
 * `notice_templates` row is used, whether the certifier list is appended, and
 * which stage is scheduled next — and all three are lookups. Four handlers
 * would be four copies of the tenancy, flag, recipient and rendering rules, and
 * the failure mode of that is a late notice that checks something the reminder
 * does not.
 *
 * Everything that decides what is sent, and to whom, is resolved **at send
 * time** from the asset's current state. Nothing is read from the job row except
 * which asset and which stage: a job queued two months ago must not carry a
 * customer id, because by the time it runs the occupant may have changed, and
 * mailing a former occupant a notice about somebody else's assembly is the exact
 * mistake the asset-centric data model exists to prevent (PRD § 5).
 *
 * The order of the checks below is load-bearing:
 *
 * 1. **The asset**, scoped to the job's purveyor. A job whose asset is gone or
 *    has moved tenant is cancelled, not failed.
 * 2. **The feature flag**, read now rather than trusted from scheduling time. A
 *    purveyor whose `automated_notices` was switched off after this job was
 *    queued gets no mail, and the job is `cancelled` — switching a paid add-on
 *    off is not a delivery failure and must not be retried as one.
 * 3. **The recipient**, through the asset's *current* customer, scoped to the
 *    asset's own purveyor. Missing or suspended means hold: no send, and the
 *    chain does not advance.
 * 4. **The request**, frozen on the job before the first send attempt: the text
 *    from the purveyor's own template row or the platform default, rendered
 *    once, *and* the sender identity (`from`, `replyTo`) the driver is
 *    configured with at that moment — everything the provider sees in the body.
 * 5. **The send**, through `sendEmail` with the job's own provider idempotency
 *    key, replaying the frozen payload on every retry. The provider sends at
 *    most one email per key, so a crash anywhere — before the request, after the
 *    provider accepted it, before its answer was recorded — is recovered by
 *    asking again, not by guessing.
 * 6. **The outcome**, recorded from the provider's answer and nowhere else.
 * 7. **The successor**, scheduled only after that record is durable, in the same
 *    transaction that completes this job — and only if this job is still
 *    `running`, so a chain a passing test or a date change ended does not
 *    restart itself.
 *
 * Steps 1–3 run on every pass. Step 3 is skipped once a payload is frozen: an
 * attempt already made is settled by replaying it to the recipient it was
 * rendered for, because re-rendering would change the payload and the provider
 * would refuse the key. A customer change after an attempt therefore takes
 * effect from the next stage.
 */

import { db } from "@bfa-platform/db";
import type { FrozenEmailPayload } from "@bfa-platform/db/schema";
import {
	bfaAssets,
	certifiers,
	customers,
	noticeTemplates,
	profiles,
	waterPurveyors,
	wpCertifierAuthorizations,
	wpFeatureFlags,
} from "@bfa-platform/db/schema";
import { and, asc, eq } from "drizzle-orm";

import {
	type EmailDriver,
	type EmailSender,
	resolveSenderIdentity,
	sendEmail,
} from "../lib/email";
import { renderTextEmail } from "../lib/email-layout";
import {
	certifierListText,
	type NoticeType,
	platformDefaultTemplate,
} from "../lib/notice-defaults";
import { nextNoticeStage, noticeRunAt } from "../lib/notice-schedule";
import {
	AUTOMATED_NOTICE_VARIABLES,
	type NoticeVariableValues,
	renderTemplate,
	variableKeys,
} from "../lib/notice-variables";
import { PROVIDER_IDEMPOTENCY_WINDOW_MS, RECIPIENT_HOLD_MS } from "./config";
import {
	cancelRunningJob,
	completeRunningJob,
	failRunningJob,
	freezeDelivery,
	holdRunningJob,
	lockAssetForChain,
	noticeIdempotencyKey,
	readJob,
	recordDelivery,
	type ScheduledJob,
	scheduleNoticeJob,
} from "./jobs";
import { logSchedulerEvent } from "./logging";
import { CANCEL_REASONS, HOLD_REASONS } from "./notice-chain";

/**
 * What one run of a notice job did.
 *
 * `held` and `cancelled` are both "no mail went out" and are deliberately
 * different results: a hold is temporary and keeps the row `pending`, a
 * cancellation is final. `superseded` means the job was withdrawn while this
 * handler was inside it.
 *
 * A thrown error is the fourth outcome and is not in this union — the loop
 * catches it and applies the retry policy, so a handler never decides its own
 * backoff.
 */
export type NoticeJobOutcome =
	| {
			kind: "sent";
			stage: NoticeType;
			/** The provider's id for this job's one email. Always confirmed. */
			providerMessageId: string;
			/**
			 * How this pass reached a confirmed delivery: the first attempt, a
			 * replay of the frozen payload under the same idempotency key, or an
			 * outcome an earlier pass had already recorded.
			 */
			deliveryPass: "first_attempt" | "idempotent_retry" | "already_recorded";
			nextStage: NoticeType | null;
	  }
	| { kind: "held"; reason: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "delivery_unconfirmed"; reason: string }
	| { kind: "superseded" };

/** The variables an automated notice may use. A closed list, from the registry. */
const ALLOWED_VARIABLES = variableKeys(AUTOMATED_NOTICE_VARIABLES);

export async function runNoticeJob(
	job: ScheduledJob,
	stage: NoticeType,
	{ now = new Date(), driver }: { now?: Date; driver?: EmailDriver } = {},
): Promise<NoticeJobOutcome> {
	if (!job.bfaAssetId) {
		return cancel(
			job,
			stage,
			"A notice job with no assembly on it cannot be sent.",
		);
	}

	// Tenancy first, and from the asset's own row. `scheduled_jobs` carries a
	// `water_purveyor_id` and the asset carries one too; if they ever disagree —
	// a restore, a corrected row — the job is not this purveyor's to run.
	const [asset] = await db
		.select({
			id: bfaAssets.id,
			waterPurveyorId: bfaAssets.waterPurveyorId,
			bin: bfaAssets.bin,
			bfaType: bfaAssets.bfaType,
			serviceAddress: bfaAssets.serviceAddress,
			annualTestDate: bfaAssets.annualTestDate,
			currentCustomerId: bfaAssets.currentCustomerId,
		})
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, job.bfaAssetId),
				eq(bfaAssets.waterPurveyorId, job.waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset) return cancel(job, stage, CANCEL_REASONS.assetGone);

	if (!asset.annualTestDate) {
		return cancel(job, stage, CANCEL_REASONS.noAnnualTestDate);
	}

	if (!(await automatedNoticesEnabled(asset.waterPurveyorId))) {
		return cancel(job, stage, CANCEL_REASONS.featureDisabled);
	}

	// The row as it is now, not as it was claimed. A previous pass may already
	// have frozen a payload or recorded the provider's answer before it died.
	const current = await readJob({ jobId: job.id });

	if (current?.status !== "running") {
		// Withdrawn after it was claimed and before anything was sent — a passing
		// test or a date change got here first. Nothing to send and nothing to
		// advance.
		return superseded(job, stage, "The job was cancelled before its send.");
	}

	const idempotencyKey = noticeIdempotencyKey(job.id);
	let rendered: RenderedNotice | null = null;
	let settled: ScheduledJob = current;

	if (!settled.providerMessageId && !settled.deliveryPayload) {
		// First attempt: decide the recipient and the words *now*, then freeze
		// them. Everything after this replays the frozen message.
		const recipient = await resolveRecipient(asset);

		if ("hold" in recipient) {
			return hold(job, stage, recipient.hold, now);
		}

		rendered = await renderNotice(asset, recipient.customer, stage, driver);

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
				return superseded(job, stage, "The job was cancelled before its send.");
			}

			settled = again;
			rendered = null;
		}
	}

	let delivery: DeliveryPass;

	if (settled.providerMessageId) {
		// The provider's confirmation is already on record — from an earlier pass
		// whose completion was lost, or from a concurrent pass that got there
		// first. Nothing is sent; the chain simply advances.
		delivery = {
			pass: "already_recorded",
			providerMessageId: settled.providerMessageId,
		};
	} else {
		const payload = settled.deliveryPayload;
		const attemptedAt = settled.deliveryAttemptedAt;
		const pass = rendered ? "first_attempt" : "idempotent_retry";

		if (!payload || !attemptedAt) {
			// Every path above ends with a recorded id or a frozen payload. A row
			// with neither is broken, and sending anything for it would be a guess.
			throw new Error(
				`Notice job ${job.id} has no frozen delivery payload to send.`,
			);
		}

		const sender = frozenSender(payload);

		// A payload frozen by the previous version of this handler has no
		// `sender` key at all: the `from` and `replyTo` of its first provider
		// request were read from the environment and never stored. That request
		// may have been accepted with its response lost, and the request body
		// cannot be rebuilt, so any replay risks a 409 under the key or — if sent
		// as the current sender — a body that was never the original. This does
		// not depend on age: a legacy row is unsafe to replay a minute later.
		if (sender.kind === "legacy") {
			return deliveryUnconfirmed(
				job,
				stage,
				idempotencyKey,
				attemptedAt,
				"legacy_sender_not_frozen",
			);
		}

		// Outside the provider's de-duplication window a replay could send a
		// second email, and the true outcome of the first attempt can no longer be
		// learned. Neither guessing "delivered" nor guessing "not delivered" is
		// acceptable, so the job fails, visibly, for a person to resolve.
		if (
			pass === "idempotent_retry" &&
			now.getTime() - attemptedAt.getTime() > PROVIDER_IDEMPOTENCY_WINDOW_MS
		) {
			return deliveryUnconfirmed(
				job,
				stage,
				idempotencyKey,
				attemptedAt,
				"idempotency_window_expired",
			);
		}

		// The one shared send path. The frozen payload is replayed exactly, with
		// the job's key, so the provider sends at most one email for this job no
		// matter how many attempts reach this line. A refusal throws, the payload
		// stays frozen, and the loop's retry policy re-queues the job — with no
		// successor, because nothing has been confirmed.
		const result = await sendEmail(
			{
				to: payload.to,
				subject: payload.subject,
				html: payload.html,
				tags: payload.tags,
				// The sender fixed at the first attempt — never the environment's
				// current one — so this body is the first attempt's body. An
				// explicit `null` was frozen under a driver with no sender to pin
				// (the console driver); it leaves the driver to use its own
				// configuration, which then makes the first request any provider
				// sees under this key. A *missing* key never reaches here — see
				// the legacy check above.
				sender: sender.kind === "pinned" ? sender.sender : null,
				idempotencyKey,
			},
			{
				event: `notice_${stage}`,
				recipientId: payload.recipientId,
				wpId: asset.waterPurveyorId,
				assetId: asset.id,
			},
			driver,
		);

		// Durable before anything depends on it. The next stage is scheduled only
		// after this commit, so a crash from here on is recovered by the
		// `already_recorded` branch rather than by another send.
		await recordDelivery({
			jobId: job.id,
			providerMessageId: result.id,
			at: now,
		});

		logSchedulerEvent("scheduler_delivery_recorded", {
			jobId: job.id,
			jobType: stage,
			assetId: asset.id,
			waterPurveyorId: asset.waterPurveyorId,
			customerId: payload.recipientId,
			extra: {
				idempotency_key: idempotencyKey,
				provider_message_id: result.id,
				driver: result.driver,
				delivery_pass: pass,
			},
		});

		delivery = { pass, providerMessageId: result.id };
	}

	const successor = nextNoticeStage(stage);

	// One transaction for the two writes that have to agree: this job is done,
	// and the next one exists. Under the asset's lock, so a date change or a
	// passing test cannot interleave: either they committed first and this row is
	// no longer `running`, or this commits first and they cancel the successor.
	const finished = await db.transaction(async (tx) => {
		await lockAssetForChain(tx, asset.id);

		const completed = await completeRunningJob({ executor: tx, jobId: job.id });

		if (!completed) return null;

		if (successor && asset.annualTestDate) {
			await scheduleNoticeJob({
				executor: tx,
				assetId: asset.id,
				waterPurveyorId: asset.waterPurveyorId,
				stage: successor,
				runAt: noticeRunAt(asset.annualTestDate, successor),
			});
		}

		return completed;
	});

	if (!finished) {
		logSchedulerEvent("scheduler_job_superseded", {
			jobId: job.id,
			jobType: stage,
			assetId: asset.id,
			waterPurveyorId: asset.waterPurveyorId,
			extra: {
				reason:
					"The job was cancelled while it was running; no successor was scheduled.",
				idempotency_key: idempotencyKey,
				provider_message_id: delivery.providerMessageId,
			},
		});

		return { kind: "superseded" };
	}

	logSchedulerEvent("scheduler_job_completed", {
		jobId: job.id,
		jobType: stage,
		assetId: asset.id,
		waterPurveyorId: asset.waterPurveyorId,
		customerId: current.deliveryPayload?.recipientId ?? rendered?.customerId,
		extra: {
			idempotency_key: idempotencyKey,
			provider_message_id: delivery.providerMessageId,
			delivery_pass: delivery.pass,
			template_source: rendered?.templateSource ?? null,
			certifier_count: rendered?.certifierCount ?? null,
			next_stage: successor,
			next_run_at:
				successor && asset.annualTestDate
					? noticeRunAt(asset.annualTestDate, successor).toISOString()
					: null,
		},
	});

	return {
		kind: "sent",
		stage,
		providerMessageId: delivery.providerMessageId,
		deliveryPass: delivery.pass,
		nextStage: successor,
	};
}

type DeliveryPass = {
	pass: "first_attempt" | "idempotent_retry" | "already_recorded";
	providerMessageId: string;
};

type RenderedNotice = {
	payload: FrozenEmailPayload;
	customerId: string;
	templateSource: "purveyor" | "platform";
	certifierCount: number;
};

/**
 * The message this stage sends to this customer, rendered once.
 *
 * `renderTemplate → renderTextEmail`, the only rendering path; `sendEmail` is
 * called by the handler with the frozen result. `recipientId` travels with the
 * payload for the delivery log and is not part of what the provider receives.
 *
 * The sender identity is resolved here too, from the driver the send will use,
 * so the frozen payload holds the provider's *whole* request body — content and
 * sender — before the first provider call. Resolving it reads configuration
 * only; it neither sends nor logs.
 */
async function renderNotice(
	asset: {
		id: string;
		waterPurveyorId: string;
		bin: string;
		bfaType: string;
		serviceAddress: string;
		annualTestDate: string | null;
	},
	customer: { id: string; name: string; email: string },
	stage: NoticeType,
	driver: EmailDriver | undefined,
): Promise<RenderedNotice> {
	const sender = await resolveSenderIdentity(driver);
	const wpName = await purveyorName(asset.waterPurveyorId);
	const template = await resolveTemplate(asset.waterPurveyorId, stage);

	const values: NoticeVariableValues = {
		customer_name: customer.name,
		wp_name: wpName,
		bfa_type: asset.bfaType,
		bin: asset.bin,
		service_address: asset.serviceAddress,
		due_date: asset.annualTestDate,
	};

	const subject = renderTemplate(template.subject, values, ALLOWED_VARIABLES);
	const body = renderTemplate(template.body, values, ALLOWED_VARIABLES);

	// The reminder, and only the reminder, carries the list of testers. A late
	// notice is a compliance escalation, not an offer of help, and the customer
	// already had the list two months earlier.
	const certifiers =
		stage === "reminder"
			? await activeCertifiersFor(asset.waterPurveyorId)
			: [];
	const certifierBlock =
		stage === "reminder" ? certifierListText(certifiers) : null;
	const text = certifierBlock ? `${body}\n\n${certifierBlock}` : body;

	return {
		payload: {
			to: customer.email,
			subject,
			// Escaped by `templateToHtml` inside `renderTextEmail`, then wrapped in
			// the one shared shell. No HTML template, no second layout.
			html: renderTextEmail({ subject, text }),
			tags: [
				{ name: "type", value: stage },
				{ name: "wp_id", value: asset.waterPurveyorId },
				{ name: "asset_id", value: asset.id },
			],
			sender,
			recipientId: customer.id,
		},
		customerId: customer.id,
		templateSource: template.source,
		certifierCount: certifierBlock ? certifierBlock.split("\n").length - 1 : 0,
	};
}

/**
 * What a frozen payload says about its sender, told apart by whether the JSON
 * object *has* a `sender` key — never by collapsing absent and `null`:
 *
 * - `pinned` — `{ from, replyTo }` frozen before the first provider call.
 * - `none` — an explicit `null`: frozen under a driver with no sender to pin.
 *   Safe to replay; the driver supplies its own.
 * - `legacy` — no key at all: frozen by the version of this handler that did
 *   not store the sender. The first request's sender is unknowable.
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

/**
 * Ends a job whose first attempt cannot be safely replayed, without sending:
 * its attempt is older than the provider's de-duplication window, or its
 * payload predates the frozen sender identity.
 */
async function deliveryUnconfirmed(
	job: ScheduledJob,
	stage: NoticeType,
	idempotencyKey: string,
	attemptedAt: Date,
	cause: keyof typeof UNCONFIRMED_REASONS,
): Promise<NoticeJobOutcome> {
	const reason = UNCONFIRMED_REASONS[cause];
	const failed = await failRunningJob({ jobId: job.id, reason });

	if (!failed) return { kind: "superseded" };

	logSchedulerEvent("scheduler_delivery_unconfirmed", {
		jobId: job.id,
		jobType: stage,
		assetId: job.bfaAssetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: {
			idempotency_key: idempotencyKey,
			delivery_attempted_at: attemptedAt.toISOString(),
			cause,
			reason,
		},
	});

	return { kind: "delivery_unconfirmed", reason };
}

/**
 * Whether this purveyor has the `automated_notices` add-on switched on.
 *
 * A missing row is off. Automated notices are a paid add-on the Super-Admin
 * enables per purveyor (PRD § 9), so the absence of a flag is the default state
 * of every new tenant and must never be read as permission to start mailing
 * their customers.
 */
async function automatedNoticesEnabled(
	waterPurveyorId: string,
): Promise<boolean> {
	const [flag] = await db
		.select({ isEnabled: wpFeatureFlags.isEnabled })
		.from(wpFeatureFlags)
		.where(
			and(
				eq(wpFeatureFlags.waterPurveyorId, waterPurveyorId),
				eq(wpFeatureFlags.feature, "automated_notices"),
			),
		)
		.limit(1);

	return flag?.isEnabled === true;
}

type RecipientResult =
	| { customer: { id: string; name: string; email: string } }
	| { hold: string };

/**
 * Who this notice goes to: the customer *currently* attached to the asset.
 *
 * Scoped to the asset's own purveyor as well as by id. `current_customer_id` is
 * a foreign key and nothing in it says the customer shares the asset's tenant;
 * `assignCustomer` refuses to point one across, but a row written before that
 * rule or restored from a backup is not bound by it, and a notice is the one
 * place a mispointed row would be mailed to the wrong company's customer.
 *
 * Suspension holds the asset's whole pipeline rather than skipping one email
 * (PRD § 9). The stage stays pending and the chain does not advance, so
 * nothing later in the escalation is consumed by a notice that was never sent.
 */
async function resolveRecipient(asset: {
	waterPurveyorId: string;
	currentCustomerId: string | null;
}): Promise<RecipientResult> {
	if (!asset.currentCustomerId) return { hold: HOLD_REASONS.noCustomer };

	const [customer] = await db
		.select({
			id: customers.id,
			name: customers.name,
			email: customers.email,
			status: customers.status,
		})
		.from(customers)
		.where(
			and(
				eq(customers.id, asset.currentCustomerId),
				eq(customers.waterPurveyorId, asset.waterPurveyorId),
			),
		)
		.limit(1);

	if (!customer) return { hold: HOLD_REASONS.noCustomer };
	if (customer.status === "suspended") {
		return { hold: HOLD_REASONS.suspendedCustomer };
	}
	if (!customer.email.trim()) return { hold: HOLD_REASONS.noEmail };

	return {
		customer: { id: customer.id, name: customer.name, email: customer.email },
	};
}

/**
 * The text for this stage: the purveyor's row where they wrote one, the
 * platform's where they did not.
 *
 * Column by column, not row by row. `subject` and `body` are both nullable, and
 * half a template saved is not a reason to send half an email — the same rule
 * `listNoticeTemplates` applies when it renders the editor, so what a purveyor
 * previews is what a customer receives.
 *
 * `is_enabled` is deliberately not read. Whether a purveyor sends automated
 * notices at all is `wp_feature_flags.automated_notices`; a per-stage switch is
 * a control with undefined behaviour until what disabling a middle step means
 * for the escalation chain is answered, and reading the column here would be
 * building it by accident.
 */
async function resolveTemplate(
	waterPurveyorId: string,
	stage: NoticeType,
): Promise<{ subject: string; body: string; source: "purveyor" | "platform" }> {
	const [row] = await db
		.select({
			subject: noticeTemplates.subject,
			body: noticeTemplates.body,
		})
		.from(noticeTemplates)
		.where(
			and(
				eq(noticeTemplates.waterPurveyorId, waterPurveyorId),
				eq(noticeTemplates.noticeType, stage),
			),
		)
		.limit(1);

	const fallback = platformDefaultTemplate(stage);
	const subject = row?.subject?.trim() ? row.subject : null;
	const body = row?.body?.trim() ? row.body : null;

	return {
		subject: subject ?? fallback.subject,
		body: body ?? fallback.body,
		source: subject && body ? "purveyor" : "platform",
	};
}

/**
 * The testers a customer of this purveyor can actually call.
 *
 * Both columns, and they mean different things. `authorization_status = 'active'`
 * is the purveyor's own relationship with the tester; `certifiers.status =
 * 'active'` is whether that tester has platform access at all. A certifier
 * revoked by this purveyor still works for others, and a blocked certifier
 * works for nobody — either one is a name that must not appear in this email.
 *
 * Resolved at send time, never cached and never stored on the job: a certifier
 * blocked yesterday must not appear in today's reminder.
 */
async function activeCertifiersFor(waterPurveyorId: string) {
	return (
		db
			.select({
				fullName: profiles.fullName,
				company: certifiers.company,
				idNumber: certifiers.idNumber,
			})
			.from(certifiers)
			.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
			.innerJoin(
				wpCertifierAuthorizations,
				eq(wpCertifierAuthorizations.certifierId, certifiers.id),
			)
			.where(
				and(
					eq(wpCertifierAuthorizations.waterPurveyorId, waterPurveyorId),
					eq(wpCertifierAuthorizations.authorizationStatus, "active"),
					eq(certifiers.status, "active"),
				),
			)
			// `id` breaks the tie so two testers with the same name keep a stable
			// order between one customer's email and the next.
			.orderBy(asc(profiles.fullName), asc(certifiers.id))
	);
}

/** The purveyor's own name, for `{{wp_name}}`. */
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
	stage: NoticeType,
	reason: string,
): Promise<NoticeJobOutcome> {
	const cancelled = await cancelRunningJob({ jobId: job.id, reason });

	if (!cancelled) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_cancelled", {
		jobId: job.id,
		jobType: stage,
		assetId: job.bfaAssetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: { reason, trigger: "job_execution" },
	});

	return { kind: "cancelled", reason };
}

async function superseded(
	job: ScheduledJob,
	stage: NoticeType,
	reason: string,
): Promise<NoticeJobOutcome> {
	logSchedulerEvent("scheduler_job_superseded", {
		jobId: job.id,
		jobType: stage,
		assetId: job.bfaAssetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: { reason, idempotency_key: noticeIdempotencyKey(job.id) },
	});

	return { kind: "superseded" };
}

async function hold(
	job: ScheduledJob,
	stage: NoticeType,
	reason: string,
	now: Date,
): Promise<NoticeJobOutcome> {
	const runAt = new Date(now.getTime() + RECIPIENT_HOLD_MS);
	const held = await holdRunningJob({ jobId: job.id, reason, runAt });

	if (!held) return { kind: "superseded" };

	logSchedulerEvent("scheduler_job_held", {
		jobId: job.id,
		jobType: stage,
		assetId: job.bfaAssetId,
		waterPurveyorId: job.waterPurveyorId,
		extra: { reason, held_until: runAt.toISOString() },
	});

	return { kind: "held", reason };
}
