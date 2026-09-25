import { cn } from "@bfa-platform/ui/lib/utils";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"field-sizing-content flex min-h-20 w-full min-w-0 resize-none rounded-md border border-input bg-card px-3 py-2.5 text-foreground text-sm outline-none transition-colors",
				"placeholder:text-text-tertiary",
				"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
				"disabled:pointer-events-none disabled:opacity-60",
				"aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
