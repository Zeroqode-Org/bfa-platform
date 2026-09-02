import { cn } from "@bfa-platform/ui/lib/utils";
import type * as React from "react";

type PageTitleProps = React.ComponentProps<"h1"> & {
	/** Optional uppercase eyebrow shown above the title (section context). */
	kicker?: React.ReactNode;
};

/** The single page-level H1 — the only place the Sora display face is used. */
function PageTitle({ kicker, className, children, ...props }: PageTitleProps) {
	return (
		<div className="flex flex-col gap-1">
			{kicker ? (
				<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
					{kicker}
				</span>
			) : null}
			<h1
				data-slot="page-title"
				className={cn(
					"font-bold font-display text-[26px] text-foreground leading-tight tracking-[-0.01em]",
					className,
				)}
				{...props}
			>
				{children}
			</h1>
		</div>
	);
}

export { PageTitle };
