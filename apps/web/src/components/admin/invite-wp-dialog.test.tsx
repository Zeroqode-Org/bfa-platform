// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Invite-new-WP form behaviour: what it sends, and what it shows while the
 * request is in flight, when it succeeds, and when the server refuses.
 *
 * The tRPC module is mocked because importing it for real would give the
 * mutation a live HTTP link. `mutationOptions` is a thin passthrough in the
 * real proxy too, so the component still runs against a genuine React Query
 * mutation — only the transport is replaced.
 */

const mutationFn = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		invitations: {
			createInvitation: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["invitations", "createInvitation"],
					mutationFn: (input: unknown) => mutationFn(input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: vi.fn() },
}));

const { InviteWpForm } = await import("./invite-wp-dialog");

function renderForm(onClose = vi.fn()) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});

	render(
		<QueryClientProvider client={queryClient}>
			<InviteWpForm onClose={onClose} />
		</QueryClientProvider>,
	);

	return { onClose };
}

function fillAndSubmit() {
	fireEvent.change(screen.getByLabelText("Company name"), {
		target: { value: "Riverside Water District" },
	});
	fireEvent.change(screen.getByLabelText("Contact email"), {
		target: { value: "admin@riversidewater.gov" },
	});
	fireEvent.click(screen.getByRole("button", { name: /send invite/i }));
}

beforeEach(() => {
	mutationFn.mockReset();
	toastSuccess.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("InviteWpForm", () => {
	it("sends a provisioning invitation: wp_admin, no purveyor, and the name", async () => {
		mutationFn.mockResolvedValue({
			id: "invitation-1",
			email: "admin@riversidewater.gov",
			role: "wp_admin",
			expiresAt: new Date(),
			waterPurveyorId: null,
			proposedWaterPurveyorName: "Riverside Water District",
		});

		renderForm();
		fillAndSubmit();

		await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1));
		expect(mutationFn).toHaveBeenCalledWith({
			email: "admin@riversidewater.gov",
			role: "wp_admin",
			waterPurveyorId: null,
			proposedWaterPurveyorName: "Riverside Water District",
		});
	});

	it("closes and confirms that the link is in the server log, not in an email", async () => {
		mutationFn.mockResolvedValue({
			id: "invitation-1",
			email: "admin@riversidewater.gov",
			role: "wp_admin",
			expiresAt: new Date(),
			waterPurveyorId: null,
			proposedWaterPurveyorName: "Riverside Water District",
		});

		const { onClose } = renderForm();
		fillAndSubmit();

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

		expect(toastSuccess).toHaveBeenCalledWith(
			"Invitation created for admin@riversidewater.gov",
			expect.objectContaining({
				description: expect.stringContaining(
					"invite link is in the server log",
				),
			}),
		);
		// It must not claim an email went out — none did.
		const description = String(toastSuccess.mock.calls[0]?.[1]?.description);
		expect(description).not.toMatch(/email (has been |was )?sent/i);
		expect(description).toContain("Riverside Water District");
	});

	it("disables the controls and relabels the button while the request is in flight", async () => {
		let release: ((value: unknown) => void) | undefined;
		mutationFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		renderForm();
		fillAndSubmit();

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /sending invite/i }),
			).toBeTruthy(),
		);
		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		await act(async () => {
			release?.({
				id: "invitation-1",
				email: "admin@riversidewater.gov",
				role: "wp_admin",
				expiresAt: new Date(),
				waterPurveyorId: null,
				proposedWaterPurveyorName: "Riverside Water District",
			});
		});
	});

	it("shows the server's message and keeps the dialog open when the call is refused", async () => {
		mutationFn.mockRejectedValue(new Error("Super-Admin only"));

		const { onClose } = renderForm();
		fillAndSubmit();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Super-Admin only");

		// The dialog stays put so the values are still there to correct.
		expect(onClose).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(
			(screen.getByLabelText("Company name") as HTMLInputElement).value,
		).toBe("Riverside Water District");
		// And the form is usable again rather than stuck in its pending state.
		expect(
			(
				screen.getByRole("button", {
					name: /send invite/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});
});
