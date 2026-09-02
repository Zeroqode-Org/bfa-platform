import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@bfa-platform/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
	"group/button inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-clip-padding font-semibold text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary-hover",
				outline:
					"border-input bg-card text-foreground hover:bg-muted aria-expanded:bg-muted",
				secondary:
					"border-input bg-secondary text-secondary-foreground hover:bg-muted aria-expanded:bg-muted",
				ghost: "text-foreground hover:bg-muted aria-expanded:bg-muted",
				destructive:
					"bg-danger-bg text-danger hover:bg-danger-bg/70 focus-visible:ring-destructive/20",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-3.5",
				xs: "h-7 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
				sm: "h-8 px-3 text-xs",
				lg: "h-10 px-5",
				icon: "size-9",
				"icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-sm": "size-8",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
