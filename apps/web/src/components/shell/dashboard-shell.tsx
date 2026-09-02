import { LogOut } from "lucide-react";
import Link from "next/link";

import { ImpersonationBanner } from "./impersonation-banner";
import { PageTransition } from "./page-transition";
import { SidebarNav } from "./sidebar-nav";
import { TopHeader } from "./top-header";

/**
 * Desktop-oriented shell for the Water Purveyor and Super-Admin apps: a fixed
 * 216px white sidebar, a full-width impersonation banner above everything, a
 * top header with the current company/context name, and a scrollable content
 * region.
 */
export function DashboardShell({
	variant,
	headerTitle,
	headerKicker,
	headerAction,
	children,
}: {
	variant: "wp" | "admin";
	headerTitle: string;
	headerKicker?: string;
	headerAction?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex h-svh flex-col overflow-hidden">
			<ImpersonationBanner />
			<div className="flex min-h-0 flex-1 bg-background">
				<SidebarNav
					variant={variant}
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
				<div className="flex min-w-0 flex-1 flex-col">
					<TopHeader
						title={headerTitle}
						kicker={headerKicker}
						action={headerAction}
					/>
					<main className="flex-1 overflow-y-auto p-7">
						<PageTransition>{children}</PageTransition>
					</main>
				</div>
			</div>
		</div>
	);
}
