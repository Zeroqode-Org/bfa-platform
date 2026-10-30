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
 * Invite-certifier form behaviour: what it sends, and what it shows while the
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

const { InviteCertifierForm } = await import("./invite-certifier-dialog");

const invitation = {
	id: "invitation-1",
	email: "tester@example.com",
	role: "certifier" as const,
	expiresAt: new Date(),
	waterPurveyorId: "3d5f4a12-9b8c-4d0e-a1f2-3b4c5d6e7f80",
	proposedWaterPurveyorName: null,
	emailDelivery: "sent" as const,
};

function renderForm(onClose = vi.fn()) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});

	render(
		<QueryClientProvider client={queryClient}>
			<InviteCertifierForm onClose={onClose} />
		</QueryClientProvider>,
	);

	return { onClose };
}

function fillAndSubmit(
	email = "tester@example.com",
	type: "Internal" | "External" = "External",
) {
	fireEvent.change(screen.getByLabelText("Certifier email"), {
		target: { value: email },
	});
	fireEvent.click(screen.getByRole("radio", { name: type }));
	fireEvent.click(screen.getByRole("button", { name: /send invite/i }));
}

beforeEach(() => {
	mutationFn.mockReset();
	toastSuccess.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("InviteCertifierForm", () => {
	it("sends exactly the email and the certifier role", async () => {
		mutationFn.mockResolvedValue(invitation);

		renderForm();
		fillAndSubmit();

		await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1));
		expect(mutationFn).toHaveBeenCalledWith({
			email: "tester@example.com",
			role: "certifier",
			certifierType: "external",
		});
	});

	it("never names a water purveyor — the server reads it off the caller", async () => {
		// The whole tenant boundary for this dialog. A field here would be a field
		// a client could put somebody else's purveyor in.
		mutationFn.mockResolvedValue(invitation);

		renderForm();
		fillAndSubmit();

		await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1));
		const payload = Object.keys(mutationFn.mock.calls[0][0]);
		expect(payload).not.toContain("waterPurveyorId");
		expect(payload).not.toContain("proposedWaterPurveyorName");
		expect(payload.sort()).toEqual(["certifierType", "email", "role"]);
	});

	it("does not submit without an address", () => {
		// `required` plus `type="email"` — the browser refuses the submit, so the
		// mutation is never reached and there is no request to explain away. The
		// refusal is the app's own inline message, not a browser tooltip.
		renderForm();
		const input = screen.getByLabelText("Certifier email") as HTMLInputElement;
		const form = input.closest("form") as HTMLFormElement;

		expect(form.noValidate).toBe(true);
		expect(input.required).toBe(false);
		expect(screen.queryAllByRole("alert")).toHaveLength(0);

		fireEvent.click(screen.getByRole("radio", { name: "External" }));
		fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

		expect(mutationFn).not.toHaveBeenCalled();
		const message = screen.getByRole("alert");
		expect(message.textContent).toBe("Certifier email is required.");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toContain(message.id);
		expect(document.activeElement).toBe(input);
	});

	it("rejects an address that is not one before it reaches the server, and clears once fixed", async () => {
		mutationFn.mockResolvedValue(invitation);
		renderForm();
		const input = screen.getByLabelText("Certifier email");

		fireEvent.click(screen.getByRole("radio", { name: "Internal" }));
		fireEvent.change(input, { target: { value: "tester@" } });
		fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

		expect(mutationFn).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe(
			"Please enter a valid email address.",
		);

		fireEvent.change(input, { target: { value: "tester@example.com" } });
		expect(screen.queryByRole("alert")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /send invite/i }));
		await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1));
	});

	it("closes and confirms that Resend accepted the invitation", async () => {
		mutationFn.mockResolvedValue(invitation);

		const { onClose } = renderForm();
		fillAndSubmit();

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

		expect(toastSuccess).toHaveBeenCalledWith(
			"Invitation created for tester@example.com",
			expect.objectContaining({
				description: expect.stringContaining(
					"An invitation email has been sent.",
				),
			}),
		);
		const description = String(toastSuccess.mock.calls[0]?.[1]?.description);
		expect(description).not.toContain("server log");
	});

	it("points to the server log when the console driver handled the invitation", async () => {
		mutationFn.mockResolvedValue({ ...invitation, emailDelivery: "logged" });

		renderForm();
		fillAndSubmit();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(String(toastSuccess.mock.calls[0]?.[1]?.description)).toContain(
			"Email delivery is not enabled; the invite link is available in the server log.",
		);
	});

	it("says that an existing certifier keeps their profile", async () => {
		// The second-WP path, stated where the person sending the invite is, so a
		// certifier who never sees a profile form is expected rather than a bug.
		renderForm();

		expect(
			screen.getByText(/already works for another purveyor keeps their/i),
		).toBeTruthy();
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
			(screen.getByLabelText("Certifier email") as HTMLInputElement).disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		await act(async () => {
			release?.(invitation);
		});
	});

	it("shows the server's message and keeps the dialog open when the call is refused", async () => {
		mutationFn.mockRejectedValue(
			new Error("You can only invite people to your own water purveyor"),
		);

		const { onClose } = renderForm();
		fillAndSubmit();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(
			"You can only invite people to your own water purveyor",
		);

		// The dialog stays put so the address is still there to correct.
		expect(onClose).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(
			(screen.getByLabelText("Certifier email") as HTMLInputElement).value,
		).toBe("tester@example.com");
		// And the form is usable again rather than stuck in its pending state.
		expect(
			(
				screen.getByRole("button", {
					name: /send invite/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("sends the type the purveyor chose", async () => {
		mutationFn.mockResolvedValue(invitation);

		renderForm();
		fillAndSubmit("tester@example.com", "Internal");

		await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1));
		expect(mutationFn.mock.calls[0][0].certifierType).toBe("internal");
	});

	it("does not submit until internal or external is chosen", () => {
		// No preselected answer: which list a certifier is filed under is the
		// purveyor's decision, not a default nobody looked at.
		renderForm();
		fireEvent.change(screen.getByLabelText("Certifier email"), {
			target: { value: "tester@example.com" },
		});
		expect(
			screen
				.getAllByRole("radio")
				.map((radio) => radio.getAttribute("aria-checked")),
		).toEqual(["false", "false"]);

		fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

		expect(mutationFn).not.toHaveBeenCalled();
		const message = screen.getByRole("alert");
		expect(message.textContent).toBe("Choose internal or external.");
		expect(
			screen.getByRole("radiogroup").getAttribute("aria-describedby"),
		).toBe(message.id);

		fireEvent.click(screen.getByRole("radio", { name: "Internal" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
