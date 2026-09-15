// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const clearImpersonationCookie = vi.fn();
const signInWithPassword = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/clear-impersonation", () => ({ clearImpersonationCookie }));
vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({ auth: { signInWithPassword } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

const { LoginForm } = await import("./login-form");

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
	replace.mockReset();
	refresh.mockReset();
	clearImpersonationCookie.mockImplementation(async () => {
		calls.push("clearImpersonation");
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
		const form = screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement;
		expect(form.noValidate).toBe(true);
		expect(form.querySelectorAll("[required]")).toHaveLength(0);
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
	});

	it("asks for both fields inline and does not call Supabase", () => {
		renderForm();
		submit();
		expect(signInWithPassword).not.toHaveBeenCalled();
		expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
			"Email is required.", "Password is required.",
		]);
		expect(document.activeElement).toBe(screen.getByLabelText("Email"));
	});

	it("refuses an invalid email at the field and clears it once corrected", () => {
		renderForm();
		const email = screen.getByLabelText("Email");
		fireEvent.change(email, { target: { value: "you@" } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
		submit();
		expect(signInWithPassword).not.toHaveBeenCalled();
		const message = screen.getByRole("alert");
		expect(message.textContent).toBe("Please enter a valid email address.");
		expect(email.getAttribute("aria-describedby")).toBe(message.id);
		fireEvent.change(email, { target: { value: "you@example.com" } });
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("reports a refused sign-in without clearing impersonation", async () => {
		signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
		renderForm();
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: " you@example.com " } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
		submit();
		expect((await screen.findByRole("alert")).textContent).toContain("Invalid login credentials");
		expect(signInWithPassword).toHaveBeenCalledWith({ email: "you@example.com", password: "hunter22" });
		expect(clearImpersonationCookie).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});

	it("clears impersonation after successful sign-in and before navigating", async () => {
		renderForm();
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@example.com" } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
		submit();
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
		expect(clearImpersonationCookie).toHaveBeenCalledWith("sign_in");
		expect(calls).toEqual(["signIn", "clearImpersonation", "replace"]);
		expect(refresh).toHaveBeenCalled();
	});
});
