// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The general-info broadcast composer: a plain form — who it is sent to (never
 * pre-chosen), what it says about the audience before anything is sent, what
 * the send carries (literal text, no variables), and what a read-only role is
 * shown instead of the send button.
 *
 * The tRPC module is mocked because importing it for real would give the
 * queries a live HTTP link. `queryOptions`/`mutationOptions` are thin
 * passthroughs in the real proxy too, so the component still runs against
 * genuine React Query state — only the transport is replaced.
 */

const audienceFn = vi.fn();
const sendFn = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		notices: {
			getBroadcastAudience: {
				queryOptions: (input: { recipientFilter: string }) => ({
					queryKey: ["notices", "getBroadcastAudience", input],
					queryFn: () => audienceFn(input),
				}),
			},
			sendGeneralInfoBroadcast: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["notices", "sendGeneralInfoBroadcast"],
					mutationFn: (input: unknown) => sendFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { GeneralInfoBroadcast } = await import("./general-info-broadcast");

const COUNTS: Record<string, number> = {
	all_customers: 12,
	agricultural_only: 3,
	past_due_only: 5,
};

function renderComposer({ canSend = true }: { canSend?: boolean } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	render(
		<QueryClientProvider client={queryClient}>
			<GeneralInfoBroadcast canSend={canSend} />
		</QueryClientProvider>,
	);
}

/** Chooses an audience in the Recipients select. */
function chooseRecipients(name: RegExp = /^All customers$/) {
	fireEvent.click(screen.getByLabelText("Recipients"));

	// Base UI commits an option on the pointer sequence, not on a bare click.
	const option = screen.getByRole("option", { name });
	fireEvent.pointerDown(option);
	fireEvent.pointerUp(option);
	fireEvent.click(option);
}

/** Types a subject and body. */
function compose({
	subject = "Water main flushing",
	body = "Hello, the mains are being flushed next week.",
} = {}) {
	fireEvent.change(screen.getByLabelText("Subject"), {
		target: { value: subject },
	});
	fireEvent.change(screen.getByLabelText("Message"), {
		target: { value: body },
	});
}

beforeEach(() => {
	audienceFn.mockReset();
	sendFn.mockReset();
	audienceFn.mockImplementation(
		({ recipientFilter }: { recipientFilter: string }) =>
			Promise.resolve({
				recipientFilter,
				recipientCount: COUNTS[recipientFilter] ?? 0,
			}),
	);
	sendFn.mockImplementation((input: { recipientFilter: string }) =>
		Promise.resolve({
			recipientFilter: input.recipientFilter,
			recipientCount: COUNTS[input.recipientFilter] ?? 0,
			sentCount: COUNTS[input.recipientFilter] ?? 0,
		}),
	);
});

afterEach(() => {
	cleanup();
});

describe("GeneralInfoBroadcast — choosing the recipients", () => {
	it("opens with no audience chosen and counts nobody until one is", async () => {
		renderComposer();

		const trigger = screen.getByLabelText("Recipients");
		expect(trigger.textContent).toContain("Select…");
		expect(trigger.hasAttribute("data-placeholder")).toBe(true);
		expect(
			screen.getByText(/Choose the recipients to see how many customers/),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Send broadcast" })).toBeTruthy();
		// The placeholder is never sent as an audience, not even to count it.
		expect(audienceFn).not.toHaveBeenCalled();
	});

	it("refuses to send without recipients, at the field, and clears once they are chosen", async () => {
		renderComposer();
		compose();

		fireEvent.click(screen.getByRole("button", { name: "Send broadcast" }));

		expect(sendFn).not.toHaveBeenCalled();
		const trigger = screen.getByLabelText("Recipients");
		const message = screen.getByText("Select the recipients.");
		expect(message.getAttribute("data-slot")).toBe("field-error");
		expect(trigger.getAttribute("aria-invalid")).toBe("true");
		expect(trigger.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.activeElement).toBe(trigger);

		chooseRecipients();

		expect(screen.queryByText("Select the recipients.")).toBeNull();
		expect(trigger.getAttribute("aria-invalid")).toBeNull();
		expect(
			await screen.findByText(/All customers — 12 recipients/),
		).toBeTruthy();
	});

	it("counts the recipients while the chosen audience is loading", () => {
		audienceFn.mockReturnValue(new Promise(() => {}));
		renderComposer();

		chooseRecipients();

		expect(screen.getByText(/counting recipients/i)).toBeTruthy();
	});

	it("names the chosen audience and its size before anything is sent", async () => {
		renderComposer();

		chooseRecipients();

		expect(
			await screen.findByText(/All customers — 12 recipients/),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		).toBeTruthy();
	});

	it("re-counts when the audience changes", async () => {
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);

		chooseRecipients(/past-due assembly/i);

		await waitFor(() => {
			expect(audienceFn).toHaveBeenCalledWith({
				recipientFilter: "past_due_only",
			});
		});
		expect(
			await screen.findByText(/past-due assembly — 5 recipients/i),
		).toBeTruthy();
	});
});

describe("GeneralInfoBroadcast", () => {
	it("is a plain form: recipients, subject, message and send — no variables or preview", async () => {
		renderComposer();

		await screen.findByLabelText("Subject");

		expect(screen.getByLabelText("Recipients")).toBeTruthy();
		expect(screen.getByLabelText("Message")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Send broadcast" })).toBeTruthy();
		// Nothing offers a placeholder, and nothing previews a substitution.
		expect(screen.queryByRole("button", { name: /insert/i })).toBeNull();
		expect(screen.queryByText("Dynamic values")).toBeNull();
		expect(screen.queryByText("Preview")).toBeNull();
		expect(screen.queryByText(/sample values/i)).toBeNull();
		// Send is the only button on the card.
		expect(
			screen.getAllByRole("button").map((button) => button.textContent),
		).toEqual(["Send broadcast"]);
	});

	it("treats braces typed by hand as plain text", async () => {
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);
		compose({
			subject: "About {{bin}}",
			body: "Hello {{customer_name}} — {{nope}} stays as typed.",
		});

		// No warning, no refusal: it is not placeholder syntax on this form.
		expect(screen.queryByRole("alert")).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		);

		await waitFor(() => {
			expect(sendFn).toHaveBeenCalledWith({
				subject: "About {{bin}}",
				body: "Hello {{customer_name}} — {{nope}} stays as typed.",
				recipientFilter: "all_customers",
			});
		});
	});

	it("sends the composed message with the selected audience", async () => {
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);
		compose();

		fireEvent.click(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		);

		await waitFor(() => {
			expect(sendFn).toHaveBeenCalledWith({
				subject: "Water main flushing",
				body: "Hello, the mains are being flushed next week.",
				recipientFilter: "all_customers",
			});
		});
	});

	it("will not send an empty message, and says which fields are missing", async () => {
		renderComposer();

		chooseRecipients();
		const send = await screen.findByRole("button", {
			name: /send to 12 recipients/i,
		});
		// Not a dead button: pressing it explains what is missing, at the fields.
		expect((send as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(send);

		expect(sendFn).not.toHaveBeenCalled();
		expect(screen.getByText("Subject is required.")).toBeTruthy();
		expect(screen.getByText("Message is required.")).toBeTruthy();
		expect(document.activeElement).toBe(screen.getByLabelText("Subject"));

		compose();
		expect(screen.queryByText("Subject is required.")).toBeNull();
		expect(screen.queryByText("Message is required.")).toBeNull();
	});

	it("reports sending while the broadcast is in flight", async () => {
		sendFn.mockReturnValue(new Promise(() => {}));
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);
		compose();
		fireEvent.click(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		);

		expect(
			await screen.findByRole("button", { name: /sending…/i }),
		).toBeTruthy();
	});

	it("confirms how many customers were written to", async () => {
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);
		compose();
		fireEvent.click(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		);

		expect(
			await screen.findByText(/Sent to 12 customers — All customers\./),
		).toBeTruthy();
	});

	it("reports a delivery failure rather than a success", async () => {
		sendFn.mockRejectedValue(
			new Error(
				"Broadcast incomplete: 8 of 12 messages were sent and 4 failed.",
			),
		);
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);
		compose();
		fireEvent.click(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		);

		expect(await screen.findByText(/broadcast incomplete/i)).toBeTruthy();
		expect(screen.queryByText(/^Sent to/)).toBeNull();
	});

	it("hides the send control from a read-only role and says why", async () => {
		renderComposer({ canSend: false });

		await screen.findByLabelText("Subject");

		expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
		expect(screen.getByText(/only a wp admin/i)).toBeTruthy();
		expect(
			(screen.getByLabelText("Subject") as HTMLInputElement).disabled,
		).toBe(true);
	});
});
