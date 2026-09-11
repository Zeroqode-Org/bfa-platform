"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "@bfa-platform/ui/lib/utils";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";

/**
 * Single-choice form control — the popup twin of `Input`, styled from the same
 * tokens so a select and a text field sitting next to each other in a form read
 * as one control family.
 *
 * Built on Base UI rather than a native `<select>` because the rest of the
 * package is: the trigger has to carry the same border, radius and focus ring
 * as `Input`, and a native select's popup cannot be styled to match the
 * approved menu surface.
 */
function Select<Value>(props: SelectPrimitive.Root.Props<Value>) {
	return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: SelectPrimitive.Group.Props) {
	return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: SelectPrimitive.Value.Props) {
	return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
	className,
	children,
	...props
}: SelectPrimitive.Trigger.Props) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				"flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2.5 text-left text-foreground text-sm outline-none transition-colors",
				"data-[placeholder]:text-text-tertiary",
				"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
				"disabled:pointer-events-none disabled:opacity-60",
				"aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon
				data-slot="select-icon"
				className="text-muted-foreground"
			>
				<ChevronsUpDownIcon className="size-3.5" />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	align = "start",
	side = "bottom",
	sideOffset = 4,
	...props
}: SelectPrimitive.Popup.Props &
	Pick<SelectPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				className="isolate z-50 outline-none"
				align={align}
				side={side}
				sideOffset={sideOffset}
				// The popup matches the trigger's width so the options line up with
				// the closed control rather than jumping to their own measure.
				alignItemWithTrigger={false}
			>
				<SelectPrimitive.Popup
					data-slot="select-content"
					className={cn(
						"data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 z-50 max-h-(--available-height) w-(--anchor-width) min-w-40 origin-(--transform-origin) overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-card)] outline-none duration-100 data-closed:animate-out data-open:animate-in",
						className,
					)}
					{...props}
				>
					<SelectPrimitive.List data-slot="select-list">
						{children}
					</SelectPrimitive.List>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

function SelectItem({
	className,
	children,
	...props
}: SelectPrimitive.Item.Props) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-7 text-[13px] outline-none",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				"data-highlighted:bg-accent data-highlighted:text-accent-foreground",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemIndicator
				data-slot="select-item-indicator"
				className="absolute left-2 flex items-center"
			>
				<CheckIcon className="size-3.5" />
			</SelectPrimitive.ItemIndicator>
			<SelectPrimitive.ItemText data-slot="select-item-text">
				{children}
			</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	);
}

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
};
