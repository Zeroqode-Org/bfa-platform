"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@bfa-platform/ui/components/dropdown-menu";
import { cn } from "@bfa-platform/ui/lib/utils";
import { ChevronsUpDown } from "lucide-react";

import { useActiveWp } from "@/lib/use-active-wp";

/**
 * Context switcher for the certifier's active water purveyor. Sits in the
 * certifier shell header (compact on mobile). Everything the certifier does —
 * new tests, drafts, submitted list — is scoped to the selected WP.
 */
export function WpSwitcher({
	compact = false,
	className,
}: {
	compact?: boolean;
	className?: string;
}) {
	const { active, list, setActiveWp } = useActiveWp();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"flex min-w-0 items-center gap-2 rounded-md border border-input bg-card px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 data-[popup-open]:bg-muted",
					className,
				)}
			>
				{!compact && (
					<span className="shrink-0 text-muted-foreground">Working for</span>
				)}
				<span className="truncate font-semibold text-foreground">
					{active.name}
				</span>
				<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				sideOffset={6}
				className="min-w-[220px]"
			>
				<DropdownMenuRadioGroup value={active.id} onValueChange={setActiveWp}>
					<DropdownMenuLabel>Switch water purveyor</DropdownMenuLabel>
					{list.map((wp) => (
						<DropdownMenuRadioItem key={wp.id} value={wp.id} closeOnClick>
							{wp.name}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
