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
 */
export const consoleDriver: EmailDriver = {
	name: "console",
	async send(message) {
		const id = `console_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

		console.log(
			JSON.stringify({
				event: "email_console_delivery",
				driver: "console",
				email_id: id,
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
 * `replyTo` is provider configuration, not part of {@link EmailMessage}: every
 * transactional email routes replies to the same mailbox, so no call site
 * chooses it.
 */
export const providerDriver: EmailDriver = {
	name: "provider",
	async send(message) {
		const { env } = await import("@bfa-platform/env/server");
		const apiKey = env.RESEND_API_KEY;
		const from = env.RESEND_FROM_EMAIL;
		const replyTo = env.RESEND_REPLY_TO;

		if (!apiKey || !from || !replyTo) {
			throw new Error(
				"EMAIL_DRIVER=provider requires RESEND_API_KEY, RESEND_FROM_EMAIL and RESEND_REPLY_TO to be set.",
			);
		}

		const { data, error } = await new Resend(apiKey).emails.send({
			from,
			replyTo,
			to: message.to,
			subject: message.subject,
			html: message.html,
			tags: message.tags,
		});

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
};

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
