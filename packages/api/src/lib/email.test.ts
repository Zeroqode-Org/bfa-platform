import { afterEach, describe, expect, it, vi } from "vitest";

import {
	consoleDriver,
	type EmailDriver,
	resolveEmailDriver,
	sendEmail,
} from "./email";

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return { lines, spy };
}

afterEach(() => {
	vi.restoreAllMocks();
});

const message = {
	to: "invitee@example.com",
	subject: "You have been invited",
	html: '<a href="http://localhost:3001/invite/abc123">Set up your account</a>',
	tags: [{ name: "type", value: "invitation" }],
};

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

describe("resolveEmailDriver", () => {
	it("defaults to the console driver", () => {
		expect(resolveEmailDriver(undefined).name).toBe("console");
	});

	it("selects by name", () => {
		expect(resolveEmailDriver("console").name).toBe("console");
	});

	it("refuses a driver that is not registered yet", () => {
		expect(() => resolveEmailDriver("provider")).toThrow(
			/Unknown EMAIL_DRIVER/,
		);
	});
});

describe("sendEmail", () => {
	it("emits one structured attempt line carrying the context identifiers", async () => {
		const { lines } = captureLogs();

		await sendEmail(message, {
			event: "invitation_created",
			actorId: "actor-1",
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
			wp_id: "wp-1",
			invitation_id: "invite-1",
			asset_id: null,
			recipient_id: null,
		});
		expect(typeof attempt?.timestamp).toBe("string");
		expect(typeof attempt?.email_id).toBe("string");
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
});
