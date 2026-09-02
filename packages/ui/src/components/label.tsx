import { cn } from "@bfa-platform/ui/lib/utils";
import type * as React from "react";

function Label({ className, ...props }: React.ComponentProps<"label">) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: generic primitive; callers pass htmlFor or wrap the control
		<label
			data-slot="label"
			className={cn(
				"select-none font-medium text-muted-foreground text-xs",
				"peer-disabled:opacity-60",
				className,
			)}
			{...props}
		/>
	);
}

export { Label };
