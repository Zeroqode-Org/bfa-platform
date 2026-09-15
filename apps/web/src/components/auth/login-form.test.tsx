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
 * Signing in starts clean: whatever impersonation cookie the browser still
 * holds is cleared before the new session reaches a route gate. This is the
 * backstop for a sign-out whose own clear never reached the server.
 */

const calls: string[] = [];
const clearMutate = vi.fn();
const signInWithPassword = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpcClient: {
		session: {
			clearImpersonation: {
				mutate: (input: unknown) => clearMutate(input),
			},
		},
	},
}));

vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({
		auth: {
			signInWithPassword: (input: unknown) => signInWithPassword(input),
		},
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace, refresh }),
}));

const { LoginForm } = await import("./login-form");

function submit() {
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: "nathan@example.com" },
	});
	fireEvent.change(screen.getByLabelText("Password"), {
		target: { value: "correct horse" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
	calls.length = 0;
	clearMutate.mockReset();
	signInWithPassword.mockReset();
	replace.mockReset();
	refresh.mockReset();

	clearMutate.mockImplementation(async () => {
		calls.push("clearImpersonation");
		return { cleared: true };
	});
	signInWithPassword.mockImplementation(async () => {
		calls.push("signIn");
		return { error: null };
	});
	replace.mockImplementation(() => calls.push("replace"));
});

afterEach(() => {
	cleanup();
});

describe("LoginForm", () => {
	it("clears any impersonation cookie after signing in and before navigating", async () => {
		render(<LoginForm redirectTo="/" />);
		submit();

		await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
		expect(clearMutate).toHaveBeenCalledWith({ reason: "sign_in" });
		expect(calls).toEqual(["signIn", "clearImpersonation", "replace"]);
	});

	it("does not touch the cookie when the sign-in is refused", async () => {
		signInWithPassword.mockResolvedValue({
			error: { message: "Invalid login credentials" },
		});

		render(<LoginForm redirectTo="/" />);
		submit();

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Invalid login credentials",
		);
		expect(clearMutate).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});
});
