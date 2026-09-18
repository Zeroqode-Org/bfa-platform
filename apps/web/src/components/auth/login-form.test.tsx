// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const clearImpersonationCookie = vi.fn();
const signInWithPassword = vi.fn();
const signOut = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/clear-impersonation", () => ({ clearImpersonationCookie }));
vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({ auth: { signInWithPassword, signOut } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

const { LoginForm, SIGN_IN_INCOMPLETE_MESSAGE } = await import("./login-form");

function fillValid() {
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: "you@example.com" },
	});
	fireEvent.change(screen.getByLabelText("Password"), {
		target: { value: "hunter22" },
	});
}

function renderForm() {
	render(<LoginForm redirectTo="/" />);
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
	calls.length = 0;
	clearImpersonationCookie.mockReset();
	signInWithPassword.mockReset();
	signOut.mockReset();
	replace.mockReset();
	refresh.mockReset();
	clearImpersonationCookie.mockImplementation(async () => {
		calls.push("clearImpersonation");
		return true;
	});
	signOut.mockImplementation(async () => {
		calls.push("signOut");
		return { error: null };
	});
	signInWithPassword.mockImplementation(async () => {
		calls.push("signIn");
		return { error: null };
	});
	replace.mockImplementation(() => calls.push("replace"));
});

afterEach(cleanup);

describe("LoginForm", () => {
	it("opts out of browser validation", () => {
		renderForm();
		const form = screen
			.getByRole("button", { name: "Sign in" })
			.closest("form") as HTMLFormElement;
		expect(form.noValidate).toBe(true);
		expect(form.querySelectorAll("[required]")).toHaveLength(0);
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("asks for both fields inline and does not call Supabase", () => {
		renderForm();
		submit();
		expect(signInWithPassword).not.toHaveBeenCalled();
		expect(
			screen.getAllByRole("alert").map((node) => node.textContent),
		).toEqual(["Email is required.", "Password is required."]);
		expect(document.activeElement).toBe(screen.getByLabelText("Email"));
	});

	it("refuses an invalid email at the field and clears it once corrected", () => {
		renderForm();
		const email = screen.getByLabelText("Email");
		fireEvent.change(email, { target: { value: "you@" } });
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "hunter22" },
		});
		submit();
		expect(signInWithPassword).not.toHaveBeenCalled();
		const message = screen.getByRole("alert");
		expect(message.textContent).toBe("Please enter a valid email address.");
		expect(email.getAttribute("aria-describedby")).toBe(message.id);
		fireEvent.change(email, { target: { value: "you@example.com" } });
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("reports a refused sign-in without clearing impersonation", async () => {
		signInWithPassword.mockResolvedValue({
			error: { message: "Invalid login credentials" },
		});
		renderForm();
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: " you@example.com " },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "hunter22" },
		});
		submit();
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Invalid login credentials",
		);
		expect(signInWithPassword).toHaveBeenCalledWith({
			email: "you@example.com",
			password: "hunter22",
		});
		expect(clearImpersonationCookie).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});

	it("clears impersonation after successful sign-in and before navigating", async () => {
		renderForm();
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "you@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "hunter22" },
		});
		submit();
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
		expect(clearImpersonationCookie).toHaveBeenCalledWith("sign_in");
		expect(calls).toEqual(["signIn", "clearImpersonation", "replace"]);
		expect(refresh).toHaveBeenCalled();
		expect(signOut).not.toHaveBeenCalled();
	});

	it("does not navigate when the sign-in clear fails: a form error and a usable retry", async () => {
		clearImpersonationCookie.mockImplementationOnce(async () => {
			calls.push("clearImpersonation");
			return false;
		});

		renderForm();
		fillValid();
		submit();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe(SIGN_IN_INCOMPLETE_MESSAGE);
		// Nothing about cookies, impersonation or signing leaks into the copy.
		expect(alert.textContent).not.toMatch(
			/cookie|impersonat|token|sign(ed|ing)? key/i,
		);

		expect(replace).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		// The session just created is dropped, so a typed URL cannot bypass the form.
		expect(signOut).toHaveBeenCalledWith({ scope: "local" });
		expect(calls).toEqual(["signIn", "clearImpersonation", "signOut"]);

		const button = screen.getByRole("button", {
			name: "Sign in",
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(false);

		// Retrying goes through the whole sequence again, and navigates once the clear succeeds.
		submit();
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
		expect(signInWithPassword).toHaveBeenCalledTimes(2);
		expect(clearImpersonationCookie).toHaveBeenCalledTimes(2);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// This case alone is not what stops an old impersonation: the browser may
	// keep both the new session and the old cookie. The server-side session
	// binding covers it — see `app/(wp)/impersonation-session-binding.test.ts`.
	it("still does not navigate if dropping the new session also fails", async () => {
		clearImpersonationCookie.mockResolvedValueOnce(false);
		signOut.mockRejectedValueOnce(new Error("offline"));

		renderForm();
		fillValid();
		submit();

		expect((await screen.findByRole("alert")).textContent).toBe(
			SIGN_IN_INCOMPLETE_MESSAGE,
		);
		expect(replace).not.toHaveBeenCalled();
		expect(
			(screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});
});
