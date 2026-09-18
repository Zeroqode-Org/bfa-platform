// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/auth";

/**
 * The shells' scrolling `<main>` has to be the containing block for anything
 * absolutely positioned on the page.
 *
 * Regression: `sr-only` text is `position: absolute`. With no positioned
 * ancestor its containing block was the viewport, so a label sitting far down a
 * long page — the dashboard charts' screen-reader tables — escaped `<main>`'s
 * `overflow-y-auto` and the shell's `overflow-hidden` and extended the document
 * itself. On a phone the whole screen then scrolled on past the tab bar into
 * empty space. The page-enter animation's transform contained it for 160ms,
 * which is why it only showed once the page had settled.
 *
 * jsdom lays nothing out, so this asserts the contract rather than measuring.
 */

vi.mock("next/navigation", () => ({
	usePathname: () => "/wp",
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
	createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

const { DashboardShell } = await import("./dashboard-shell");
const { CertifierShell } = await import("./certifier-shell");

const account = {
	profileId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
	fullName: "Casey Tester",
	globalRole: "wp_admin",
	waterPurveyorId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f",
	waterPurveyorName: "Riverside Water District",
	email: "casey@example.com",
} as Account;

function Page() {
	return (
		<div>
			<p>Page content</p>
			<span className="sr-only">Screen-reader only label</span>
		</div>
	);
}

function withQueryClient(ui: React.ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

afterEach(() => {
	cleanup();
});

describe("shell scroll container", () => {
	it.each([
		[
			"DashboardShell",
			() => (
				<DashboardShell variant="wp" account={account} headerTitle="Riverside">
					<Page />
				</DashboardShell>
			),
		],
		[
			"CertifierShell",
			() =>
				withQueryClient(
					<CertifierShell account={account}>
						<Page />
					</CertifierShell>,
				),
		],
	])(
		"%s contains absolutely positioned page content in <main>",
		(_name, ui) => {
			render(ui());

			const main = screen.getByRole("main");
			const label = screen.getByText("Screen-reader only label");

			expect(main.contains(label)).toBe(true);
			// The scroll container clips and scrolls; `relative` is what makes it the
			// box an absolute descendant is placed against rather than the viewport.
			expect(main.className).toContain("overflow-y-auto");
			expect(main.className).toContain("relative");
		},
	);
});
