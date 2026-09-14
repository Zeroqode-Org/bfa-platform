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
 * The general-info broadcast composer: which variables it offers, what it says
 * about the audience before anything is sent, what the send carries, and what a
 * read-only role is shown instead of the send button.
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

/** Types a subject and body, which is what makes the send button live. */
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

describe("GeneralInfoBroadcast", () => {
	it("counts the recipients while the audience is loading", () => {
		audienceFn.mockReturnValue(new Promise(() => {}));
		renderComposer();

		expect(screen.getByText(/counting recipients/i)).toBeTruthy();
	});

	it("names the audience and its size before anything is sent", async () => {
		renderComposer();

		expect(
			await screen.findByText(/All customers — 12 recipients/),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /send to 12 recipients/i }),
		).toBeTruthy();
	});

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

		await screen.findByLabelText("Subject");
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

	it("re-counts when the audience changes", async () => {
		renderComposer();

		await screen.findByText(/All customers — 12 recipients/);

		fireEvent.click(screen.getByLabelText("Recipients"));

		// Base UI commits an option on the pointer sequence, not on a bare click.
		const option = await screen.findByRole("option", {
			name: /past-due assembly/i,
		});
		fireEvent.pointerDown(option);
		fireEvent.pointerUp(option);
		fireEvent.click(option);

		await waitFor(() => {
			expect(audienceFn).toHaveBeenCalledWith({
				recipientFilter: "past_due_only",
			});
		});
		expect(
			await screen.findByText(/past-due assembly — 5 recipients/i),
		).toBeTruthy();
	});

	it("sends the composed message with the selected audience", async () => {
		renderComposer();

		await screen.findByLabelText("Subject");
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

		await screen.findByLabelText("Subject");
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

		await screen.findByLabelText("Subject");
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

		await screen.findByLabelText("Subject");
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

		expect(screen.queryByRole("button", { name: /send to/i })).toBeNull();
		expect(screen.getByText(/only a wp admin/i)).toBeTruthy();
		expect(
			(screen.getByLabelText("Subject") as HTMLInputElement).disabled,
		).toBe(true);
	});
});
