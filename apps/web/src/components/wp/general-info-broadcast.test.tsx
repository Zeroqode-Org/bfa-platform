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
 * The general-info broadcast composer: who it is sent to (never pre-chosen),
 * which variables it offers, what it says about the audience before anything
 * is sent, what the send carries, and what a read-only role is shown instead of
 * the send button.
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
	subject = "News from {{wp_name}}",
	body = "Hello {{customer_name}}, the mains are being flushed.",
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
				sampleValues: {
					customer_name: "Sample Customer",
					wp_name: "Harbor Water Works",
				},
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
	it("offers only the two variables a customer has one of", async () => {
		renderComposer();

		await screen.findByLabelText("Subject");

		expect(
			screen.getByRole("button", { name: /Insert \{\{customer_name\}\}/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Insert \{\{wp_name\}\}/ }),
		).toBeTruthy();
		// An asset may be one of several a customer owns, so there is no single
		// value to substitute — and no button offering one.
		for (const placeholder of [
			"bin",
			"bfa_type",
			"service_address",
			"due_date",
		]) {
			expect(
				screen.queryByRole("button", {
					name: new RegExp(`Insert \\{\\{${placeholder}\\}\\}`),
				}),
			).toBeNull();
		}
	});

	it("substitutes the sample recipient in the preview", async () => {
		renderComposer();

		chooseRecipients();
		await screen.findByText(/All customers — 12 recipients/);
		compose();

		expect(
			await screen.findByText("News from Harbor Water Works"),
		).toBeTruthy();
		expect(
			screen.getByText("Hello Sample Customer, the mains are being flushed."),
		).toBeTruthy();
	});

	it("warns in the preview when an asset variable is used", async () => {
		renderComposer();

		await screen.findByLabelText("Subject");
		compose({ body: "Your {{bin}} is due." });

		expect(screen.getByRole("alert").textContent).toContain(
			"cannot be used here",
		);
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
				subject: "News from {{wp_name}}",
				body: "Hello {{customer_name}}, the mains are being flushed.",
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
