"use client";

import { cn } from "@bfa-platform/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { certifierNav } from "@/config/nav";

export function BottomTabBar({ className }: { className?: string }) {
	const pathname = usePathname();

	return (
		<nav
			className={cn(
				"flex shrink-0 border-border-soft border-t bg-card",
				className,
			)}
		>
			{certifierNav.map(({ href, label, icon: Icon }) => {
				const active = pathname === href || pathname.startsWith(`${href}/`);
				return (
					<Link
						key={href}
						href={href}
						aria-current={active ? "page" : undefined}
						className={cn(
							"flex flex-1 flex-col items-center gap-1 px-1 py-2 text-center font-medium text-[11px] leading-tight transition-colors",
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
