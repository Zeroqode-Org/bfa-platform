// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first-login form: which fields it asks for (decided by the invitation,
 * passed in from the server), what it refuses inline before the server action
 * runs, and how the action's own refusal is shown.
 *
 * The server action is mocked. It re-parses everything it receives, and that
 * rule set has its own tests; what matters here is whether the form calls it
 * at all, and with what.
 */

const redeemInvitationAction = vi.fn();

vi.mock("@/app/invite/[token]/actions", () => ({
	redeemInvitationAction: (previous: unknown, formData: FormData) =>
		redeemInvitationAction(previous, formData),
}));

const { RedeemForm } = await import("./redeem-form");

function renderCertifierForm() {
	render(<RedeemForm secret="s3cret" mode="new_profile" isCertifier />);
}

function submit(name = "Create my account") {
	fireEvent.click(screen.getByRole("button", { name }));
}

function fillCertifier({
	licenseExpirationDate = "04/01/2027",
	confirmPassword = "Correct horse 1!",
} = {}) {
	fireEvent.change(screen.getByLabelText("Full name"), {
		target: { value: "Alex Rivera" },
	});
	fireEvent.change(screen.getByLabelText("Company"), {
		target: { value: "Rivera Backflow Testing" },
	});
	fireEvent.change(screen.getByLabelText("Certifier ID number"), {
		target: { value: "CERT-00123" },
	});
	fireEvent.change(screen.getByLabelText("License expiration date"), {
		target: { value: licenseExpirationDate },
	});
	fireEvent.change(screen.getByLabelText("Password"), {
		target: { value: "Correct horse 1!" },
	});
	fireEvent.change(screen.getByLabelText("Confirm password"), {
		target: { value: confirmPassword },
	});
}

beforeEach(() => {
	redeemInvitationAction.mockReset();
	redeemInvitationAction.mockResolvedValue({ error: null });
});

afterEach(() => {
	cleanup();
});

describe("RedeemForm", () => {
	it("opts out of browser validation and shows nothing on arrival", () => {
		renderCertifierForm();

		const form = screen
			.getByRole("button", { name: "Create my account" })
			.closest("form") as HTMLFormElement;

		expect(form.noValidate).toBe(true);
		expect(form.querySelectorAll("[required], [minlength]")).toHaveLength(0);
		expect(form.querySelectorAll('input[type="date"]')).toHaveLength(0);
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("names every missing answer, focuses the first, and never calls the action", () => {
		renderCertifierForm();

		submit();

		expect(redeemInvitationAction).not.toHaveBeenCalled();
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual([
			"Full name is required.",
			"Company is required.",
			"Certifier ID number is required.",
			"License expiration date is required.",
			"Password is required.",
			"Confirm your password.",
		]);
		expect(document.activeElement).toBe(screen.getByLabelText("Full name"));
	});

	it("refuses an impossible license expiration date", () => {
		renderCertifierForm();

		fillCertifier({ licenseExpirationDate: "02/30/2026" });
		submit();

		expect(redeemInvitationAction).not.toHaveBeenCalled();
		const date = screen.getByLabelText("License expiration date");
		const message = screen.getByRole("alert");
		expect(message.textContent).toBe(
			"Please enter a valid date in MM/DD/YYYY format.",
		);
		expect(date.getAttribute("aria-describedby")).toBe(message.id);
		expect(document.activeElement).toBe(date);
	});

	it("says when the passwords do not match", () => {
		renderCertifierForm();

		fillCertifier({ confirmPassword: "Correct horsf 1!" });
		submit();

		expect(redeemInvitationAction).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe(
			"The passwords do not match.",
		);
	});

	it("keeps the password hint alongside a too-short password's error", () => {
		renderCertifierForm();

		const password = screen.getByLabelText("Password");
		fireEvent.change(password, { target: { value: "short" } });
		fireEvent.blur(password);

		const message = screen.getByText("Use at least 8 characters.");
		const hint = screen.getByText(
			"At least 8 characters, with a lowercase letter, a capital letter, a number and a symbol.",
		);
		expect(password.getAttribute("aria-describedby")).toBe(
			`${message.id} ${hint.id}`,
		);
	});

	it("refuses a long password missing a capital, a number or a symbol", () => {
		renderCertifierForm();

		const password = screen.getByLabelText("Password");
		fireEvent.change(password, { target: { value: "correcthorse" } });
		fireEvent.blur(password);

		expect(
			screen.getByText("Include at least one capital letter."),
		).toBeTruthy();

		fireEvent.change(password, { target: { value: "Correcthorse" } });
		fireEvent.blur(password);

		expect(screen.getByText("Include at least one number.")).toBeTruthy();

		fireEvent.change(password, { target: { value: "Correcthorse1" } });
		fireEvent.blur(password);

		expect(screen.getByText(/Include at least one symbol/)).toBeTruthy();
	});

	it("sends the server-decided mode and the date as the action's ISO day", async () => {
		renderCertifierForm();

		fillCertifier();
		submit();

		await waitFor(() =>
			expect(redeemInvitationAction).toHaveBeenCalledTimes(1),
		);

		const formData = redeemInvitationAction.mock.calls[0]?.[1] as FormData;
		expect(formData.get("secret")).toBe("s3cret");
		expect(formData.get("mode")).toBe("new_profile");
		expect(formData.get("isCertifier")).toBe("yes");
		expect(formData.get("licenseExpirationDate")).toBe("2027-04-01");
		expect(formData.get("certifierIdNumber")).toBe("CERT-00123");
	});

	it("shows the action's refusal inline", async () => {
		redeemInvitationAction.mockResolvedValue({
			error: "This invitation has expired.",
		});
		renderCertifierForm();

		fillCertifier();
		submit();

		expect((await screen.findByRole("alert")).textContent).toContain(
			"This invitation has expired.",
		);
	});

	it("asks an existing certifier for nothing and submits straight away", async () => {
		render(
			<RedeemForm secret="s3cret" mode="existing_certifier" isCertifier />,
		);

		expect(screen.queryByLabelText("Password")).toBeNull();

		submit("Add this water purveyor");

		await waitFor(() =>
			expect(redeemInvitationAction).toHaveBeenCalledTimes(1),
		);
		const formData = redeemInvitationAction.mock.calls[0]?.[1] as FormData;
		expect(formData.get("isCertifier")).toBe("no");
		expect(formData.get("licenseExpirationDate")).toBeNull();
	});
});
