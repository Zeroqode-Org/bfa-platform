import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	consoleDriver,
	type EmailDriver,
	providerDriver,
	resolveEmailDriver,
	resolveSenderIdentity,
	sendEmail,
} from "./email";

/**
 * Neither the real env nor the real SDK is loaded: a unit run has no
 * credentials to validate and must never reach Resend. The env stand-in is a
 * plain mutable object so each test can shape the configuration it needs.
 * `EMAIL_DRIVER` is read straight off `process.env`, so it is stubbed there.
 */
const mocks = vi.hoisted(() => ({
	env: {} as {
		RESEND_API_KEY: string | undefined;
		RESEND_FROM_EMAIL: string | undefined;
		RESEND_REPLY_TO: string | undefined;
	},
	resendConstructed: vi.fn(),
	send: vi.fn(),
}));

vi.mock("@bfa-platform/env/server", () => ({ env: mocks.env }));

vi.mock("resend", () => ({
	Resend: class {
		emails = { send: mocks.send };

		constructor(apiKey: string) {
			mocks.resendConstructed(apiKey);
		}
	},
}));

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return { lines, spy };
}

beforeEach(() => {
	vi.stubEnv("EMAIL_DRIVER", undefined);
	Object.assign(mocks.env, {
		RESEND_API_KEY: "re_test_not_a_real_key",
		RESEND_FROM_EMAIL: "Backflow Reporter <notifications@example.com>",
		RESEND_REPLY_TO: "info@backflowreporter.io",
	});
	mocks.resendConstructed.mockReset();
	mocks.send.mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const message = {
	to: "invitee@example.com",
	subject: "You have been invited",
	html: '<a href="http://localhost:3001/invite/abc123">Set up your account</a>',
	tags: [{ name: "type", value: "invitation" }],
};

describe("consoleDriver idempotency", () => {
	it("returns the first id and logs no second delivery for a repeated key", async () => {
		const { lines } = captureLogs();
		const key = `bfa-notice/${Math.random().toString(36).slice(2)}`;

		const first = await consoleDriver.send({ ...message, idempotencyKey: key });
		const second = await consoleDriver.send({
			...message,
			idempotencyKey: key,
		});

		expect(second.id).toBe(first.id);
		expect(
			lines.filter((line) => line.event === "email_console_delivery"),
		).toHaveLength(1);
		expect(lines[0]).toMatchObject({ idempotency_key: key });
	});

	it("delivers every unkeyed message, as it always has", async () => {
		const { lines } = captureLogs();

		const first = await consoleDriver.send(message);
		const second = await consoleDriver.send(message);

		expect(second.id).not.toBe(first.id);
		expect(lines).toHaveLength(2);
	});
});

describe("consoleDriver", () => {
	it("logs the whole payload as one JSON line and reports success", async () => {
		const { lines } = captureLogs();

		const result = await consoleDriver.send(message);

		expect(result.driver).toBe("console");
		expect(result.id).toMatch(/^console_/);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			event: "email_console_delivery",
			driver: "console",
			to: "invitee@example.com",
			subject: "You have been invited",
			html: message.html,
			tags: [{ name: "type", value: "invitation" }],
		});
		expect(typeof lines[0]?.timestamp).toBe("string");
	});

	it("prints a followable invite link, since it is the only copy there is", async () => {
		const { lines } = captureLogs();

		await consoleDriver.send(message);

		expect(String(lines[0]?.html)).toContain(
			"http://localhost:3001/invite/abc123",
		);
	});
});

describe("providerDriver", () => {
	it("maps the message onto a Resend send from RESEND_FROM_EMAIL", async () => {
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});

		await providerDriver.send(message);

		expect(mocks.resendConstructed).toHaveBeenCalledWith(
			"re_test_not_a_real_key",
		);
		expect(mocks.send).toHaveBeenCalledTimes(1);
		expect(mocks.send).toHaveBeenCalledWith({
			from: "Backflow Reporter <notifications@example.com>",
			replyTo: "info@backflowreporter.io",
			to: "invitee@example.com",
			subject: "You have been invited",
			html: message.html,
			tags: [{ name: "type", value: "invitation" }],
		});
	});

	it("passes an idempotency key to Resend as the SDK's request option", async () => {
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});

		await providerDriver.send({
			...message,
			idempotencyKey: "bfa-notice/job-1",
		});

		// The SDK turns this option into the `Idempotency-Key` header.
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({ to: "invitee@example.com" }),
			{ idempotencyKey: "bfa-notice/job-1" },
		);
		// The key is a request option, never part of the email itself.
		expect(mocks.send.mock.calls[0]?.[0]).not.toHaveProperty("idempotencyKey");
	});

	it("makes the same one-argument request as before when there is no key", async () => {
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});

		await providerDriver.send(message);

		expect(mocks.send.mock.calls[0]).toHaveLength(1);
	});

	it("returns Resend's id as the send id", async () => {
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});

		await expect(providerDriver.send(message)).resolves.toEqual({
			id: "resend-email-1",
			driver: "provider",
		});
	});

	it("does not log the payload the way the console driver does", async () => {
		const { lines } = captureLogs();
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});

		await providerDriver.send(message);

		expect(lines).toHaveLength(0);
	});

	it("throws when Resend reports an error", async () => {
		mocks.send.mockResolvedValue({
			data: null,
			error: {
				name: "validation_error",
				statusCode: 403,
				message: "The sender domain is not verified.",
			},
			headers: null,
		});

		await expect(providerDriver.send(message)).rejects.toThrow(
			"Resend refused the send (validation_error 403): The sender domain is not verified.",
		);
	});

	it("throws when Resend returns no id", async () => {
		mocks.send.mockResolvedValue({ data: {}, error: null, headers: null });

		await expect(providerDriver.send(message)).rejects.toThrow(
			/returned no email id/,
		);
	});

	it("passes RESEND_REPLY_TO to Resend exactly, whatever the message", async () => {
		mocks.env.RESEND_REPLY_TO = "info@backflowreporter.io";
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-2" },
			error: null,
			headers: null,
		});

		await providerDriver.send({
			...message,
			to: "someone.else@example.com",
			tags: [{ name: "type", value: "general_info_broadcast" }],
		});

		expect(mocks.send.mock.calls[0]?.[0]?.replyTo).toBe(
			"info@backflowreporter.io",
		);
	});

	it.each(["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_REPLY_TO"] as const)(
		"refuses to send without %s, before any request is built",
		async (key) => {
			mocks.env[key] = undefined;

			await expect(providerDriver.send(message)).rejects.toThrow(
				/requires RESEND_API_KEY, RESEND_FROM_EMAIL and RESEND_REPLY_TO/,
			);
			expect(mocks.resendConstructed).not.toHaveBeenCalled();
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);
});

describe("sender identity for replays", () => {
	const frozen = {
		from: "Old Sender <old@example.com>",
		replyTo: "old-replies@example.com",
	};

	beforeEach(() => {
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});
	});

	it("sends a pinned sender to Resend in place of the configured one", async () => {
		// The configuration has moved on since the message was frozen.
		mocks.env.RESEND_FROM_EMAIL = "New Sender <new@example.com>";
		mocks.env.RESEND_REPLY_TO = "new-replies@example.com";

		await providerDriver.send({
			...message,
			sender: frozen,
			idempotencyKey: "bfa-notice/job-1",
		});

		expect(mocks.send).toHaveBeenCalledWith(
			{
				from: "Old Sender <old@example.com>",
				replyTo: "old-replies@example.com",
				to: "invitee@example.com",
				subject: "You have been invited",
				html: message.html,
				tags: [{ name: "type", value: "invitation" }],
			},
			{ idempotencyKey: "bfa-notice/job-1" },
		);
	});

	it("still sends ordinary mail as the configured sender", async () => {
		await providerDriver.send(message);
		await providerDriver.send({ ...message, sender: null });

		for (const [payload] of mocks.send.mock.calls) {
			expect(payload).toMatchObject({
				from: "Backflow Reporter <notifications@example.com>",
				replyTo: "info@backflowreporter.io",
			});
			// The pinned-sender field is an instruction to the driver, never a
			// field of the request.
			expect(payload).not.toHaveProperty("sender");
		}
	});

	it("replays a pinned sender even when the configured one is unset", async () => {
		mocks.env.RESEND_FROM_EMAIL = undefined;
		mocks.env.RESEND_REPLY_TO = undefined;

		await expect(
			providerDriver.send({ ...message, sender: frozen }),
		).resolves.toEqual({ id: "resend-email-1", driver: "provider" });
	});

	it("still refuses to send without an API key, sender pinned or not", async () => {
		mocks.env.RESEND_API_KEY = undefined;

		await expect(
			providerDriver.send({ ...message, sender: frozen }),
		).rejects.toThrow(/requires RESEND_API_KEY/);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("resolves the provider's current sender for freezing, without sending", async () => {
		await expect(resolveSenderIdentity(providerDriver)).resolves.toEqual({
			from: "Backflow Reporter <notifications@example.com>",
			replyTo: "info@backflowreporter.io",
		});
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("refuses to resolve a sender the configuration does not have", async () => {
		mocks.env.RESEND_REPLY_TO = undefined;

		await expect(resolveSenderIdentity(providerDriver)).rejects.toThrow(
			/RESEND_REPLY_TO/,
		);
	});

	it("resolves no sender for the console driver, which has none to vary", async () => {
		await expect(resolveSenderIdentity(consoleDriver)).resolves.toBeNull();
	});

	it("passes a pinned sender through sendEmail without logging it", async () => {
		const { lines } = captureLogs();
		const seen: unknown[] = [];
		const recording: EmailDriver = {
			name: "provider",
			async send(sent) {
				seen.push(sent.sender);
				return { id: "re_abc", driver: "provider" };
			},
		};

		await sendEmail(
			{ ...message, sender: frozen, idempotencyKey: "bfa-notice/job-2" },
			{ event: "notice_reminder" },
			recording,
		);

		expect(seen).toEqual([frozen]);
		const line = JSON.stringify(lines);
		expect(line).not.toContain("old@example.com");
		expect(line).not.toContain("old-replies@example.com");
	});

	it("leaves the console driver's output unchanged by a pinned sender", async () => {
		const { lines } = captureLogs();

		await consoleDriver.send({ ...message, sender: frozen });

		expect(lines[0]).not.toHaveProperty("sender");
		expect(lines[0]).not.toHaveProperty("from");
	});
});

describe("resolveEmailDriver", () => {
	it("defaults to the console driver", () => {
		expect(resolveEmailDriver(undefined).name).toBe("console");
	});

	it("selects by name", () => {
		expect(resolveEmailDriver("console").name).toBe("console");
	});

	it("resolves the provider driver", () => {
		expect(resolveEmailDriver("provider")).toBe(providerDriver);
	});

	it("follows EMAIL_DRIVER when no name is passed", () => {
		vi.stubEnv("EMAIL_DRIVER", "provider");

		expect(resolveEmailDriver().name).toBe("provider");
	});

	it("treats an empty EMAIL_DRIVER as the console default", () => {
		vi.stubEnv("EMAIL_DRIVER", "");

		expect(resolveEmailDriver().name).toBe("console");
	});

	it("refuses a driver that is not registered", () => {
		expect(() => resolveEmailDriver("smtp")).toThrow(/Unknown EMAIL_DRIVER/);
	});
});

describe("sendEmail", () => {
	it("emits one structured attempt line carrying the context identifiers", async () => {
		const { lines } = captureLogs();

		await sendEmail(message, {
			event: "invitation_created",
			actor: { actorId: "actor-1", effectiveProfileId: "wp-admin-1" },
			wpId: "wp-1",
			invitationId: "invite-1",
		});

		const attempt = lines.find((line) => line.event === "email_send_attempted");

		expect(attempt).toMatchObject({
			email_event: "invitation_created",
			driver: "console",
			status: "sent",
			recipient: "invitee@example.com",
			actor_id: "actor-1",
			effective_profile_id: "wp-admin-1",
			wp_id: "wp-1",
			invitation_id: "invite-1",
			asset_id: null,
			recipient_id: null,
		});
		expect(typeof attempt?.timestamp).toBe("string");
		expect(typeof attempt?.email_id).toBe("string");
		expect(attempt?.idempotency_key).toBeNull();
	});

	it("hands the idempotency key to the driver and puts it on the attempt line", async () => {
		const { lines } = captureLogs();
		const seen: (string | undefined)[] = [];
		const recording: EmailDriver = {
			name: "provider",
			async send(sent) {
				seen.push(sent.idempotencyKey);
				return { id: "re_abc", driver: "provider" };
			},
		};

		await sendEmail(
			{ ...message, idempotencyKey: "bfa-notice/job-9" },
			{ event: "notice_reminder", assetId: "asset-9" },
			recording,
		);

		expect(seen).toEqual(["bfa-notice/job-9"]);
		expect(
			lines.find((line) => line.event === "email_send_attempted"),
		).toMatchObject({
			idempotency_key: "bfa-notice/job-9",
			email_id: "re_abc",
			asset_id: "asset-9",
		});
	});

	it("logs the attempt and rethrows when the driver fails", async () => {
		const { lines } = captureLogs();
		const failing: EmailDriver = {
			name: "console",
			send: () => Promise.reject(new Error("smtp exploded")),
		};

		await expect(
			sendEmail(message, { event: "invitation_created" }, failing),
		).rejects.toThrow("smtp exploded");

		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "email_send_attempted",
				status: "failed",
				error: "smtp exploded",
				recipient: "invitee@example.com",
			}),
		);
	});

	it("sends through Resend when EMAIL_DRIVER=provider and logs its id", async () => {
		const { lines } = captureLogs();
		vi.stubEnv("EMAIL_DRIVER", "provider");
		mocks.send.mockResolvedValue({
			data: { id: "resend-email-1" },
			error: null,
			headers: null,
		});

		const result = await sendEmail(message, {
			event: "invitation_created",
			invitationId: "invite-1",
		});

		expect(result).toEqual({ id: "resend-email-1", driver: "provider" });
		expect(lines).toEqual([
			expect.objectContaining({
				event: "email_send_attempted",
				driver: "provider",
				status: "sent",
				email_id: "resend-email-1",
				error: null,
				invitation_id: "invite-1",
			}),
		]);
	});

	it("logs a failed provider attempt and rethrows a Resend error", async () => {
		const { lines } = captureLogs();
		mocks.send.mockResolvedValue({
			data: null,
			error: {
				name: "rate_limit_exceeded",
				statusCode: 429,
				message: "Too many requests.",
			},
			headers: null,
		});

		await expect(
			sendEmail(message, { event: "invitation_created" }, providerDriver),
		).rejects.toThrow(/Too many requests/);

		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "email_send_attempted",
				driver: "provider",
				status: "failed",
				email_id: null,
				error:
					"Resend refused the send (rate_limit_exceeded 429): Too many requests.",
				recipient: "invitee@example.com",
			}),
		);
	});

	it("logs a failed provider attempt and rethrows when Resend returns no id", async () => {
		const { lines } = captureLogs();
		mocks.send.mockResolvedValue({ data: null, error: null, headers: null });

		await expect(
			sendEmail(message, { event: "invitation_created" }, providerDriver),
		).rejects.toThrow(/returned no email id/);

		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "email_send_attempted",
				driver: "provider",
				status: "failed",
				error: "Resend accepted the send but returned no email id.",
			}),
		);
	});
});
