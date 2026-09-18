import { LogOut } from "lucide-react";

import type { NavVariant } from "@/config/nav";
import type { Account } from "@/lib/auth";

import { BottomTabBar } from "./bottom-tab-bar";
import { ImpersonationBanner } from "./impersonation-banner";
import { LogoutButton } from "./logout-button";
import { PageTransition } from "./page-transition";
import { SidebarNav } from "./sidebar-nav";
import { SidebarUser } from "./sidebar-user";
import { TopHeader } from "./top-header";

/**
 * Shell for the Water Purveyor and Super-Admin apps: a full-width impersonation
 * banner above everything, a top header carrying the current company/context
 * name and one contextual action, and a scrollable content region. The sidebar
 * footer names the signed-in account — the header's title is the tenant, not
 * the person, and the two are not the same question.
 *
 * Desktop-oriented, but it adapts at the design system's 780px breakpoint the
 * same way the certifier shell does: >= 780px the fixed 216px white sidebar;
 * below it the sidebar is hidden and the same nav set renders as a bottom tab
 * bar, with "Log out" moving into the header. Both surfaces stay in the DOM —
 * only visibility flips, so there is no JS layout swap.
 */
export function DashboardShell({
	variant,
	account,
	headerTitle,
	headerKicker,
	headerAction,
	children,
}: {
	variant: Extract<NavVariant, "wp" | "admin">;
	account: Account;
	headerTitle: string;
	headerKicker?: string;
	headerAction?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex h-svh flex-col overflow-hidden">
			<ImpersonationBanner impersonation={account.impersonation} />
			<div className="flex min-h-0 flex-1 bg-background">
				<SidebarNav
					variant={variant}
					className="hidden min-[780px]:flex"
					footer={
						<>
							<SidebarUser account={account} />
							<LogoutButton className="flex w-full items-center gap-2.5 rounded-[5px] border-l-[3px] border-l-transparent py-2.5 pr-2 pl-3 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
								<LogOut className="size-[18px] shrink-0" strokeWidth={1.75} />
								Log out
							</LogoutButton>
						</>
					}
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<TopHeader
						title={headerTitle}
						kicker={headerKicker}
						action={
							<>
								{headerAction}
								<LogoutButton className="shrink-0 font-medium text-[13px] text-muted-foreground transition-colors hover:text-foreground min-[780px]:hidden">
									Log out
								</LogoutButton>
							</>
						}
					/>
					{/* `relative` makes this scroll container the containing block for
					    anything absolutely positioned in the page — `sr-only` text above
					    all. Without it that box is placed against the viewport instead: it
					    escapes this `overflow-y-auto` and the shell's `overflow-hidden`,
					    and a label sitting far down a long page extends the document, so
					    the whole screen scrolls into empty space below the tab bar. */}
					<main className="relative flex-1 overflow-y-auto p-4 min-[780px]:p-7">
						<PageTransition>{children}</PageTransition>
					</main>
				</div>
			</div>
			<BottomTabBar variant={variant} className="min-[780px]:hidden" />
		</div>
	);
}
