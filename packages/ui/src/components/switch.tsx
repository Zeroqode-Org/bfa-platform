"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@bfa-platform/ui/lib/utils";

/**
 * On/off switch. Renders `role="switch"` with `aria-checked`, so it reads as a
 * setting that takes effect at once rather than a form value to submit.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input outline-none transition-colors after:absolute after:-inset-x-2 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-card shadow-sm transition-transform data-checked:translate-x-[18px]"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
