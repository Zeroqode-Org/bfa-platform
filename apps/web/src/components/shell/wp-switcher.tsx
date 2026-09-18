"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@bfa-platform/ui/components/dropdown-menu";
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
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
	const { active, list, setActiveWp, isLoading, isError } = useActiveWp();

	if (isLoading) {
		return <Skeleton className={cn("h-8 w-40 rounded-md", className)} />;
	}

	// No usable WP either because the list failed to load or because it
	// genuinely came back empty — a certifier mid-onboarding may hold only a
	// `pending` authorization, which `listAuthorizedWps` does not surface.
	// Either way there is nothing to switch to, so the trigger says so and
	// does not open.
	if (isError || !active) {
		return (
			<div
				className={cn(
					"flex min-w-0 items-center gap-2 rounded-md border border-input bg-muted px-2.5 py-1.5 text-[13px] text-muted-foreground",
					className,
				)}
			>
				{isError ? "Couldn't load purveyors" : "No purveyors yet"}
			</div>
		);
	}

	// The open dropdown lists the *other* authorized WPs (§ 6.4) — the active
	// one is already named on the trigger, so repeating it as a selectable
	// option would be the one item in the list that does nothing.
	const otherWps = list.filter((wp) => wp.id !== active.id);

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
					{otherWps.length > 0 ? (
						otherWps.map((wp) => (
							<DropdownMenuRadioItem key={wp.id} value={wp.id} closeOnClick>
								{wp.name}
							</DropdownMenuRadioItem>
						))
					) : (
						<div className="px-2 py-1.5 text-[12px] text-muted-foreground">
							No other purveyors
						</div>
					)}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
