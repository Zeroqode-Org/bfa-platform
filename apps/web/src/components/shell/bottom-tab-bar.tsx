"use client";

import { cn } from "@bfa-platform/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { type NavVariant, navByVariant } from "@/config/nav";

/**
 * Mobile nav surface for every role shell (< 780px). Renders the same nav set
 * as the desktop `SidebarNav`; the two swap by CSS visibility only, so there is
 * no JS layout swap and no hydration mismatch. Longer nav sets (WP has seven
 * entries) scroll inside the bar rather than widening the page.
 */
export function BottomTabBar({
	variant,
	className,
}: {
	variant: NavVariant;
	className?: string;
}) {
	const pathname = usePathname();

	return (
		<nav
			className={cn(
				"flex shrink-0 overflow-x-auto border-border-soft border-t bg-card",
				className,
			)}
		>
			{navByVariant[variant].map(({ href, label, icon: Icon }) => {
				const active = pathname === href || pathname.startsWith(`${href}/`);
				return (
					<Link
						key={href}
						href={href}
						aria-current={active ? "page" : undefined}
						className={cn(
							"flex min-w-[76px] flex-1 flex-col items-center gap-1 px-1 py-2 text-center font-medium text-[11px] leading-tight transition-colors",
							active ? "text-primary" : "text-text-tertiary",
						)}
					>
						<Icon className="size-5 shrink-0" strokeWidth={2} />
						{label}
					</Link>
				);
			})}
		</nav>
	);
}
