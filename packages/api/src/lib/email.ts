/**
 * The one way this application sends mail.
 *
 * Feature code calls {@link sendEmail} and nothing else — it never reaches for a
 * provider SDK, and it never writes its own send log. Both live here so that
 * swapping the driver is a change to this file and to no calling site.
 *
 * Two drivers are planned. `consoleDriver` writes the whole payload — invite
 * link included — to a structured JSON log line and reports success, which is
 * what makes every mail path testable before a domain, a DNS record or an API
 * key exists. `providerDriver` lands with the transactional-email work item and
 * implements the same {@link EmailDriver} interface against a real provider; it
 * is registered in {@link drivers} and selected by `EMAIL_DRIVER`. No feature
 * code changes when it does.
 */

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
	actorId?: string | null;
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
 * The HTML is logged in full and on purpose: with no provider wired up, this
 * output is the only copy of the link a developer or a tester can follow.
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
 * Driver registry. Adding the provider is one entry here plus its module — the
 * selector, the logging and every call site stay as they are.
 */
const drivers: Partial<Record<EmailDriverName, EmailDriver>> = {
	console: consoleDriver,
};

/**
 * Selects the driver from `EMAIL_DRIVER`, defaulting to the console driver.
 *
 * Read straight off `process.env` rather than through the validated env schema:
 * the variable is optional and has a safe default until the provider exists,
 * and adding it to validation would make every environment — including CI —
 * declare a value for a switch with one position. It moves into
 * `packages/env/src/server.ts` alongside the provider's API key.
 */
export function resolveEmailDriver(
	name: string | undefined = process.env.EMAIL_DRIVER,
): EmailDriver {
	const requested = (name ?? "console") as EmailDriverName;
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
			actor_id: context.actorId ?? null,
			recipient_id: context.recipientId ?? null,
			wp_id: context.wpId ?? null,
			asset_id: context.assetId ?? null,
			invitation_id: context.invitationId ?? null,
			timestamp: new Date().toISOString(),
		}),
	);
}
