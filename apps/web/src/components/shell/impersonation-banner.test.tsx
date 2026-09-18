// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/auth";

/**
 * The impersonation banner: always there while impersonating, above the whole
 * shell, with exactly one way out — and that way out goes through the server.
 *
 * Transport and navigation are mocked; React Query and the shell are real.
 */

const endFn = vi.fn();
const hardNavigate = vi.fn();
const toastError = vi.fn();

vi.mock("@/utils/trpc", () => ({
	trpc: {
		superAdmin: {
			endImpersonation: {
				mutationOptions: (options: Record<string, unknown>) => ({
					...options,
					mutationKey: ["superAdmin", "endImpersonation"],
					mutationFn: () => endFn(),
				}),
			},
		},
	},
}));

vi.mock("@/lib/hard-navigate", () => ({
	hardNavigate: (route: string) => hardNavigate(route),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: toastError },
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/wp",
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

const { ImpersonationBanner } = await import("./impersonation-banner");
const { DashboardShell } = await import("./dashboard-shell");

const impersonatedAccount: Account = {
	profileId: "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b",
	fullName: "Riley Purveyor",
	globalRole: "wp_admin",
	waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
	waterPurveyorName: "Riverside Water District",
	email: null,
	impersonation: { waterPurveyorName: "Riverside Water District" },
};

function withQueryClient(ui: React.ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

function banner() {
	return screen.getByRole("region", { name: "Impersonation" });
}

beforeEach(() => {
	endFn.mockReset();
	hardNavigate.mockReset();
	toastError.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("ImpersonationBanner", () => {
	it("renders nothing when the account is acting as itself", () => {
		// No QueryClientProvider on purpose: an idle banner must not need one.
		const { container } = render(<ImpersonationBanner impersonation={null} />);

		expect(container.innerHTML).toBe("");
	});

	it("names the purveyor, uses the impersonation tokens, and offers exactly one control", () => {
		render(
			withQueryClient(
				<ImpersonationBanner
					impersonation={{ waterPurveyorName: "Riverside Water District" }}
				/>,
			),
		);

		expect(banner().textContent).toContain(
			"Viewing as Riverside Water District",
		);
		expect(banner().className).toContain("bg-impersonation-bg");
		expect(banner().className).toContain("text-impersonation-text");
		expect(banner().className).toContain("w-full");

		// No close icon, no dismiss, no menu — the exit is the only button.
		const buttons = within(banner()).getAllByRole("button");
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toBe("Exit impersonation");
		expect(buttons[0]?.className).toContain("underline");
	});

	it("sits above the whole shell, before the sidebar and the header", () => {
		render(
			withQueryClient(
				<DashboardShell
					variant="wp"
					account={impersonatedAccount}
					headerTitle="Riverside Water District"
				>
					<p>Page content</p>
				</DashboardShell>,
			),
		);

		const shellRoot = banner().parentElement as HTMLElement;
		expect(shellRoot.firstElementChild).toBe(banner());
		expect(banner().compareDocumentPosition(screen.getByRole("main"))).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it("ends the impersonation on the server, then reloads into /admin", async () => {
		endFn.mockResolvedValue({ ended: true });

		render(
			withQueryClient(
				<ImpersonationBanner
					impersonation={{ waterPurveyorName: "Riverside Water District" }}
				/>,
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Exit impersonation" }));

		await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/admin"));
		expect(endFn).toHaveBeenCalledTimes(1);
	});

	it("holds the exit while the request is in flight", async () => {
		let release: ((value: unknown) => void) | undefined;
		endFn.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);

		render(
			withQueryClient(
				<ImpersonationBanner
					impersonation={{ waterPurveyorName: "Riverside Water District" }}
				/>,
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Exit impersonation" }));

		const pending = (await screen.findByRole("button", {
			name: "Exiting impersonation…",
		})) as HTMLButtonElement;
		expect(pending.disabled).toBe(true);

		fireEvent.click(pending);
		expect(endFn).toHaveBeenCalledTimes(1);

		await act(async () => {
			release?.({ ended: true });
		});
	});

	it("stays up, and usable, when the server refuses to end it", async () => {
		endFn.mockRejectedValue(new Error("Super-Admin only"));

		render(
			withQueryClient(
				<ImpersonationBanner
					impersonation={{ waterPurveyorName: "Riverside Water District" }}
				/>,
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Exit impersonation" }));

		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Super-Admin only"),
		);
		expect(hardNavigate).not.toHaveBeenCalled();
		expect(banner()).toBeTruthy();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "Exit impersonation",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
	});
});
