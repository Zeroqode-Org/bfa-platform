import { cn } from "@bfa-platform/ui/lib/utils";
import type * as React from "react";

function Table({ className, ...props }: React.ComponentProps<"table">) {
	return (
		// `relative` makes the scroll container the containing block for anything
		// absolutely positioned in the table — the `sr-only` column labels above
		// all. Without it their containing block is the nearest positioned
		// ancestor further up, and when there is none it is the viewport: the
		// label then escapes both this `overflow-x-auto` and any `overflow-hidden`
		// card around it, lands at the far edge of a table wider than the screen,
		// and makes the whole page scroll sideways on a phone.
		<div
			data-slot="table-container"
			className="relative w-full overflow-x-auto"
		>
			<table
				data-slot="table"
				className={cn(
					"w-full caption-bottom border-collapse text-sm",
					className,
				)}
				{...props}
			/>
		</div>
	);
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
	return (
		<thead
			data-slot="table-header"
			className={cn(
				"bg-table-header-bg [&_tr]:border-border [&_tr]:border-b",
				className,
			)}
			{...props}
		/>
	);
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	return (
		<tbody
			data-slot="table-body"
			className={cn(
				"[&_tr:last-child]:border-0 [&_tr]:border-border-soft [&_tr]:border-b",
				className,
			)}
			{...props}
		/>
	);
}

function TableRow({
	className,
	clickable = false,
	...props
}: React.ComponentProps<"tr"> & { clickable?: boolean }) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				"transition-colors",
				clickable && "cursor-pointer hover:bg-surface-hover",
				className,
			)}
			{...props}
		/>
	);
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				"px-4 py-[11px] text-left align-middle font-semibold text-muted-foreground text-xs",
				className,
			)}
			{...props}
		/>
	);
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
	return (
		<td
			data-slot="table-cell"
			className={cn("px-4 py-[11px] align-middle text-foreground", className)}
			{...props}
		/>
	);
}

function TableCaption({
	className,
	...props
}: React.ComponentProps<"caption">) {
	return (
		<caption
			data-slot="table-caption"
			className={cn("mt-3 text-muted-foreground text-xs", className)}
			{...props}
		/>
	);
}

export {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
};
