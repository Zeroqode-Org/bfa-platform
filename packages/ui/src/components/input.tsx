import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@bfa-platform/ui/lib/utils";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				"h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2.5 text-foreground text-sm outline-none transition-colors",
				"placeholder:text-text-tertiary",
				"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
				"disabled:pointer-events-none disabled:opacity-60",
				// read-only / auto-filled: flat muted fill, not a greyed-out disabled look
				"read-only:border-transparent read-only:bg-muted read-only:text-muted-foreground read-only:focus-visible:ring-0",
				"aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
