import { cn } from "@bfa-platform/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

/**
 * Status badge — a pill of saturated text on a pale tint. Never a solid fill.
 * Colour pairs come from the design tokens (text-<x> / bg-<x>-bg).
 */
const badgeVariants = cva(
	"inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-[9px] py-[3px] font-semibold text-[11px] [&_svg]:size-3 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				primary: "bg-accent text-accent-foreground",
				neutral: "bg-muted text-muted-foreground",
				success: "bg-success-bg text-success",
				danger: "bg-danger-bg text-danger",
				warning: "bg-warning-bg text-warning",
				teal: "bg-accent-teal-bg text-accent-teal",
				purple: "bg-purple-bg text-purple",
			},
		},
		defaultVariants: {
			variant: "neutral",
		},
	},
);

function Badge({
	className,
	variant,
	...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return (
		<span
			data-slot="badge"
			className={cn(badgeVariants({ variant, className }))}
			{...props}
		/>
	);
}

export { Badge, badgeVariants };
