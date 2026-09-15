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
 * The sign-in form: what it refuses inline before asking Supabase, and where a
 * refused sign-in is reported.
 *
 * The Supabase browser client and the router are mocked — the form's job is to
 * decide whether to call them and what to show, not to exercise either.
 */

const signInWithPassword = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({ auth: { signInWithPassword } }),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace, refresh }),
}));

const { LoginForm } = await import("./login-form");

function renderForm() {
	render(<LoginForm redirectTo="/" />);
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
	signInWithPassword.mockReset();
	replace.mockReset();
	refresh.mockReset();
});

afterEach(() => {
	cleanup();
});

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

	it("reports a refused sign-in as a form message, not at either field", async () => {
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
		expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
			null,
		);
		expect(replace).not.toHaveBeenCalled();
	});

	it("goes on to the destination after a successful sign-in", async () => {
		signInWithPassword.mockResolvedValue({ error: null });
		renderForm();

		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: "you@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "hunter22" },
		});
		submit();

		await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
		expect(refresh).toHaveBeenCalled();
	});
});
