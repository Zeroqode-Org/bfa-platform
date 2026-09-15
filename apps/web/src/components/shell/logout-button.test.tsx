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
 * Logging out removes the impersonation cookie as well as the session.
 *
 * The cookie is `httpOnly` and not one of Supabase's, so `signOut` alone left it
 * in the browser: a Super-Admin who signed out mid-impersonation and signed back
 * in within the hour was dropped straight back into it. The server clear has to
 * happen first, while the session it belongs to still exists.
 */

const calls: string[] = [];
const clearMutate = vi.fn();
const signOut = vi.fn();
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
	createClient: () => ({ auth: { signOut: () => signOut() } }),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace, refresh }),
}));

const { LogoutButton } = await import("./logout-button");

beforeEach(() => {
	calls.length = 0;
	clearMutate.mockReset();
	signOut.mockReset();
	replace.mockReset();
	refresh.mockReset();

	clearMutate.mockImplementation(async () => {
		calls.push("clearImpersonation");
		return { cleared: true };
	});
	signOut.mockImplementation(async () => {
		calls.push("signOut");
		return { error: null };
	});
	replace.mockImplementation(() => calls.push("replace"));
});

afterEach(() => {
	cleanup();
});

describe("LogoutButton", () => {
	it("clears the impersonation cookie on the server before signing out", async () => {
		render(<LogoutButton>Log out</LogoutButton>);

		fireEvent.click(screen.getByRole("button", { name: "Log out" }));

		await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
		expect(clearMutate).toHaveBeenCalledWith({ reason: "sign_out" });
		expect(calls).toEqual(["clearImpersonation", "signOut", "replace"]);
	});

	it("still signs out when the clear request fails", async () => {
		// Sign-in clears the cookie again, so a failure here must not trap anybody
		// in a session they asked to leave.
		clearMutate.mockRejectedValue(new Error("network down"));

		render(<LogoutButton>Log out</LogoutButton>);

		fireEvent.click(screen.getByRole("button", { name: "Log out" }));

		await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
		expect(signOut).toHaveBeenCalledTimes(1);
	});
});
