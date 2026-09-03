import { LogOut } from "lucide-react";
import Link from "next/link";

import { BottomTabBar } from "./bottom-tab-bar";
import { PageTransition } from "./page-transition";
import { SidebarNav } from "./sidebar-nav";
import { WpSwitcher } from "./wp-switcher";

/**
 * Certifier shell. One layout that adapts by CSS at the 780px breakpoint:
 * - < 780px: a slim top bar (active-WP switcher + Log out) and a bottom tab bar.
 * - >= 780px: the same 216px sidebar as WP/Admin (Log out in its footer) plus a
 *   header row carrying the active-WP switcher.
 * Both nav surfaces are always in the DOM; only their visibility flips, so
 * there is no JS layout swap and no hydration mismatch. The content region is
 * full-width like the WP/Admin shell — a form page caps its own width (480px
 * centered per the design system); tables use the full width.
 */
export function CertifierShell({ children }: { children: React.ReactNode }) {
	const logOut = (
		<Link
			href="/"
			className="shrink-0 font-medium text-[13px] text-muted-foreground transition-colors hover:text-foreground"
		>
			Log out
		</Link>
	);

	return (
		<div className="flex h-svh flex-col overflow-hidden bg-background min-[780px]:flex-row">
			{/* Mobile top bar */}
			<header className="flex h-12 shrink-0 items-center justify-between gap-3 border-border border-b bg-card px-4 min-[780px]:hidden">
				<WpSwitcher compact className="min-w-0 flex-1" />
				{logOut}
			</header>

			{/* Desktop sidebar */}
			<SidebarNav
				variant="certifier"
				className="hidden min-[780px]:flex"
				footer={
					<Link
						href="/"
						className="flex items-center gap-2.5 rounded-[5px] border-l-[3px] border-l-transparent py-2.5 pr-2 pl-3 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<LogOut className="size-[18px] shrink-0" strokeWidth={1.75} />
						Log out
					</Link>
				}
			/>

			{/* Content column */}
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="hidden h-14 shrink-0 items-center border-border border-b bg-card px-7 min-[780px]:flex">
					<WpSwitcher />
				</header>
				<main className="flex-1 overflow-y-auto p-4 min-[780px]:p-7">
					<PageTransition>{children}</PageTransition>
				</main>
			</div>

			{/* Mobile bottom tab bar */}
			<BottomTabBar variant="certifier" className="min-[780px]:hidden" />
		</div>
	);
}
