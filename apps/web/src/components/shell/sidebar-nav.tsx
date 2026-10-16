"use client";

import { cn } from "@bfa-platform/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { type NavVariant, navByVariant } from "@/config/nav";

function isActive(pathname: string, href: string) {
	if (href === "/wp" || href === "/admin") return pathname === href;
	return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({
	variant,
	footer,
	className,
}: {
	variant: NavVariant;
	footer?: React.ReactNode;
	className?: string;
}) {
	const pathname = usePathname();
	const items = navByVariant[variant];

	return (
		<nav
			className={cn(
				"flex w-[216px] shrink-0 flex-col overflow-y-auto border-sidebar-border border-r bg-sidebar px-3.5 py-5",
				className,
			)}
		>
			<Link
				href="/"
				className="mb-5 flex items-center gap-2.5 px-2 text-foreground"
			>
				<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
					<svg
						viewBox="0 0 24 24"
						className="size-4"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
					</svg>
				</span>
				<span className="truncate font-bold text-[13px] tracking-tight">
					Backflow Reporter.io
				</span>
			</Link>

			<p className="mb-2.5 px-2 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.05em]">
				Menu
			</p>

			<ul className="flex flex-col gap-1">
				{items.map(({ href, label, icon: Icon }) => {
					const active = isActive(pathname, href);
					return (
						<li key={href}>
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex items-center gap-2.5 rounded-[5px] border-l-[3px] border-l-transparent py-2.5 pr-2 pl-3 text-[13px] transition-colors",
									active
										? "border-l-primary bg-primary/10 font-semibold text-sidebar-accent-foreground"
										: "font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
								)}
							>
								<Icon
									className={cn(
										"size-[18px] shrink-0",
										active && "text-primary",
									)}
									strokeWidth={1.75}
								/>
								{label}
							</Link>
						</li>
					);
				})}
			</ul>

			{footer ? (
				<div className="mt-auto border-border-soft border-t pt-3">{footer}</div>
			) : null}
		</nav>
	);
}
