import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "@bfa-platform/ui/lib/utils";
import type * as React from "react";

function Separator({
	className,
	orientation = "horizontal",
	...props
}: React.ComponentProps<typeof SeparatorPrimitive>) {
	return (
		<SeparatorPrimitive
			data-slot="separator"
			orientation={orientation}
			className={cn(
				"shrink-0 bg-border-soft",
				orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
				className,
			)}
			{...props}
		/>
	);
}

export { Separator };
