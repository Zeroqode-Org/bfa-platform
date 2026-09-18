/**
 * The one way this application sends mail.
 *
 * Feature code calls {@link sendEmail} and nothing else — it never reaches for a
 * provider SDK, and it never writes its own send log. Both live here so that
 * swapping the driver is a change to this file and to no calling site.
 *
 * Two drivers exist. `consoleDriver` writes the whole payload — invite link
 * included — to a structured JSON log line and reports success, which is what
 * makes every mail path testable without a provider account. `providerDriver`
 * delivers through Resend. Both implement the same {@link EmailDriver}
 * interface, are registered in {@link drivers}, and are selected by
 * `EMAIL_DRIVER`; `console` is the default, so real delivery happens only where
 * `EMAIL_DRIVER=provider` is set.
 */

import { Resend } from "resend";

import { type AuditActor, auditActorFields } from "./audit-actor";

/** Provider-agnostic label attached to a send, for filtering delivery logs. */
export type EmailTag = { name: string; value: string };

/** The full payload of one message. Providers take this shape near enough. */
export type EmailMessage = {
	to: string;
	subject: string;
	html: string;
	tags: EmailTag[];
	/**
	 * A stable key for this one logical message. Every retry of the same message
	 * must carry the same key *and* the same payload: the provider then sends at
	 * most one email however many times it is asked, and a replay returns the
	 * original email id. Omitted for mail that is not retried automatically.
	 *
	 * Resend keeps a key for 24 hours and refuses a reused key whose payload
	 * differs (409 `invalid_idempotent_request`); callers that retry past a crash
	 * must therefore replay a stored payload rather than re-render one — and
	 * "payload" means the whole request body, sender included. See `sender`.
	 */
	idempotencyKey?: string;
	/**
	 * The sender identity to send as, pinned by the caller. Omitted by ordinary
	 * mail, which sends as whatever the driver is configured with *now*.
	 *
	 * Exists for replays. The provider driver otherwise fills `from` and
	 * `replyTo` from the environment on every call, so a retry made after either
	 * variable changed would send a different body under the same idempotency key
	 * and be refused instead of returning the original email id. A caller that
	 * freezes a message resolves the sender once with {@link resolveSenderIdentity},
	 * stores it with the rest, and passes it back here on every attempt.
	 */
	sender?: EmailSender | null;
};

/**
 * The provider-visible sender of a message: the `from` and `replyTo` fields of
 * the request body. Provider configuration, not message content — but part of
 * the body the provider compares when it honours an idempotency key.
 */
export type EmailSender = {
	from: string;
	replyTo: string;
};

/** What a driver reports back. `id` is the driver's handle on the send. */
export type EmailSendResult = {
	id: string;
	driver: EmailDriverName;
};

export type EmailDriverName = "console" | "provider";

export type EmailDriver = {
	name: EmailDriverName;
	send(message: EmailMessage): Promise<EmailSendResult>;
	/**
	 * The sender this driver would send as right now, for a caller that has to
	 * freeze it before the first attempt. Absent on a driver whose request has no
	 * sender to vary — the console driver sends nowhere.
	 */
	senderIdentity?(): Promise<EmailSender>;
};

/**
 * Identifiers carried into the send log. Every field is optional because not
 * every mail path has every id — an invitation has no asset, a reminder has no
 * invitation — but whatever the caller knows is recorded.
 */
export type EmailContext = {
	/** Why this mail was sent, e.g. `invitation_created`. */
	event: string;
	/** Who sent it: the real account, and the identity it acted as. */
	actor?: AuditActor | null;
	recipientId?: string | null;
	wpId?: string | null;
	assetId?: string | null;
	invitationId?: string | null;
};

/**
 * Console driver. Logs the complete message — recipient, subject, tags and the
 * rendered HTML, which is where the invite link is — as one JSON line, then
 * reports success.
 *
 * The HTML is logged in full and on purpose: wherever the provider is not
 * switched on, this output is the only copy of the link a developer or a tester
 * can follow.
 *
 * Honours `idempotencyKey` the way the provider does, within this process: a
 * repeated key returns the first id and delivers nothing new. That keeps the
 * console driver a faithful stand-in for the scheduler's retry path. It is
 * in-memory and per-process — the console driver delivers nothing, so there is
 * nothing a restart could duplicate.
 */
const consoleIdempotency = new Map<string, string>();
const CONSOLE_IDEMPOTENCY_LIMIT = 10_000;

export const consoleDriver: EmailDriver = {
	name: "console",
	async send(message) {
		const replayed = message.idempotencyKey
			? consoleIdempotency.get(message.idempotencyKey)
			: undefined;

		if (replayed) return { id: replayed, driver: "console" };

		const id = `console_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

		if (message.idempotencyKey) {
			// Bounded so a long-lived dev server cannot grow it without limit; the
			// oldest key is the one least likely to be retried.
			if (consoleIdempotency.size >= CONSOLE_IDEMPOTENCY_LIMIT) {
				const oldest = consoleIdempotency.keys().next().value;
				if (oldest !== undefined) consoleIdempotency.delete(oldest);
			}
			consoleIdempotency.set(message.idempotencyKey, id);
		}

		console.log(
			JSON.stringify({
				event: "email_console_delivery",
				driver: "console",
				email_id: id,
				idempotency_key: message.idempotencyKey ?? null,
				to: message.to,
				subject: message.subject,
				tags: message.tags,
				html: message.html,
				timestamp: new Date().toISOString(),
			}),
		);

		return { id, driver: "console" };
	},
};

/**
 * Provider driver — delivers through Resend.
 *
 * Resend reports API failures as an `error` value rather than by throwing, so
 * both that and a response without an id are turned into thrown errors here:
 * {@link sendEmail} only logs a failure it can catch, and a caller must never be
 * handed a success for a message nobody accepted.
 *
 * The validated server env is loaded here, on first send, rather than at the top
 * of the module: importing it validates every server variable, and this module
 * must stay importable by unit suites that have none. Loading it fails a
 * misconfigured `EMAIL_DRIVER=provider` before any request is made. The
 * credentials are checked once more because `SKIP_ENV_VALIDATION` turns that
 * validation off, and a missing key should fail as a clear message rather than
 * as a request.
 *
 * `from` and `replyTo` are provider configuration: every transactional email
 * sends from the same address and routes replies to the same mailbox, so an
 * ordinary call site never chooses them and they come from the environment. The
 * one exception is a replay — a message carrying a pinned `sender` is sent with
 * exactly that sender, so a retry's body is the body of the first attempt even
 * if the configuration changed in between.
 */
export const providerDriver: EmailDriver = {
	name: "provider",
	async send(message) {
		const { env } = await import("@bfa-platform/env/server");
		const apiKey = env.RESEND_API_KEY;

		if (!apiKey) {
			throw new Error(
				"EMAIL_DRIVER=provider requires RESEND_API_KEY, RESEND_FROM_EMAIL and RESEND_REPLY_TO to be set.",
			);
		}

		const { from, replyTo } = message.sender ?? configuredSender(env);

		const payload = {
			from,
			replyTo,
			to: message.to,
			subject: message.subject,
			html: message.html,
			tags: message.tags,
		};

		// The SDK sends `idempotencyKey` as the `Idempotency-Key` header. Passed
		// only when present, so a message with no key makes exactly the request
		// it always has.
		const { data, error } = message.idempotencyKey
			? await new Resend(apiKey).emails.send(payload, {
					idempotencyKey: message.idempotencyKey,
				})
			: await new Resend(apiKey).emails.send(payload);

		if (error) {
			const status = error.statusCode ? ` ${error.statusCode}` : "";
			throw new Error(
				`Resend refused the send (${error.name}${status}): ${error.message}`,
			);
		}

		if (typeof data?.id !== "string" || data.id.length === 0) {
			throw new Error("Resend accepted the send but returned no email id.");
		}

		return { id: data.id, driver: "provider" };
	},
	async senderIdentity() {
		const { env } = await import("@bfa-platform/env/server");

		return configuredSender(env);
	},
};

/**
 * The sender the environment configures, or a thrown error naming what is
 * missing. Checked here as well as in env validation because
 * `SKIP_ENV_VALIDATION` turns that validation off.
 */
function configuredSender(env: {
	RESEND_FROM_EMAIL?: string;
	RESEND_REPLY_TO?: string;
}): EmailSender {
	const from = env.RESEND_FROM_EMAIL;
	const replyTo = env.RESEND_REPLY_TO;

	if (!from || !replyTo) {
		throw new Error(
			"EMAIL_DRIVER=provider requires RESEND_API_KEY, RESEND_FROM_EMAIL and RESEND_REPLY_TO to be set.",
		);
	}

	return { from, replyTo };
}

/**
 * Driver registry. The selector, the logging and every call site read from
 * here, so a driver is one entry plus its implementation.
 */
const drivers: Partial<Record<EmailDriverName, EmailDriver>> = {
	console: consoleDriver,
	provider: providerDriver,
};

/**
 * Selects the driver from `EMAIL_DRIVER`, defaulting to the console driver.
 *
 * Read off `process.env` so that selecting the default console driver never
 * loads the server env. The variable is still declared and validated in
 * `packages/env/src/server.ts`, which the app loads at startup; an empty value
 * counts as unset there, and does here.
 */
export function resolveEmailDriver(
	name: string | undefined = process.env.EMAIL_DRIVER,
): EmailDriver {
	const requested = (name || "console") as EmailDriverName;
	const driver = drivers[requested];

	if (!driver) {
		throw new Error(
			`Unknown EMAIL_DRIVER "${requested}". Available drivers: ${Object.keys(drivers).join(", ")}.`,
		);
	}

	return driver;
}

/**
 * The sender identity the given driver — by default the configured one — would
 * send as right now, or `null` for a driver whose request carries no sender.
 *
 * For callers that freeze a message before its first attempt, so that every
 * retry replays the same provider request body. Reads configuration only; it
 * sends nothing and logs nothing.
 */
export async function resolveSenderIdentity(
	driver: EmailDriver = resolveEmailDriver(),
): Promise<EmailSender | null> {
	return driver.senderIdentity ? driver.senderIdentity() : null;
}

/**
 * Sends one message through the configured driver and emits exactly one
 * structured JSON line per attempt, whether the driver succeeded or threw.
 *
 * Failures are re-thrown. A caller that must not fail on a send — a background
 * notice, say — catches; a caller where the mail *is* the feature, like an
 * invitation, lets it propagate rather than reporting a success nobody received.
 */
export async function sendEmail(
	message: EmailMessage,
	context: EmailContext,
	driver: EmailDriver = resolveEmailDriver(),
): Promise<EmailSendResult> {
	try {
		const result = await driver.send(message);

		logSendAttempt(message, context, driver, { status: "sent", id: result.id });

		return result;
	} catch (error) {
		logSendAttempt(message, context, driver, {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		});

		throw error;
	}
}

function logSendAttempt(
	message: EmailMessage,
	context: EmailContext,
	driver: EmailDriver,
	outcome: { status: "sent"; id: string } | { status: "failed"; error: string },
) {
	console.log(
		JSON.stringify({
			event: "email_send_attempted",
			email_event: context.event,
			driver: driver.name,
			status: outcome.status,
			email_id: outcome.status === "sent" ? outcome.id : null,
			// Pairs this attempt with its retries and with the scheduler job the
			// key is derived from. Never secret: it is a job id with a prefix.
			idempotency_key: message.idempotencyKey ?? null,
			error: outcome.status === "failed" ? outcome.error : null,
			recipient: message.to,
			subject: message.subject,
			...auditActorFields(context.actor),
			recipient_id: context.recipientId ?? null,
			wp_id: context.wpId ?? null,
			asset_id: context.assetId ?? null,
			invitation_id: context.invitationId ?? null,
			timestamp: new Date().toISOString(),
		}),
	);
}
