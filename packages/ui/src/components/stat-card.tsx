import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import { cn } from "@bfa-platform/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

/**
 * The design system's stat card: a 3px colored accent along the top, an icon
 * chip in the matching tint, a small muted label, and the number in large bold
 * type.
 *
 * Here rather than beside the one screen that currently uses it because the
 * skill names it as a component of the system, with fixed measurements — and
 * the Super-Admin dashboard has the same row of cards in the approved
 * prototype. A second screen re-deriving "3px accent, 34px chip, 24/700
 * number" from prose is how two dashboards end up almost matching.
 *
 * Three tones, and they are a vocabulary rather than a palette:
 *
 *   * `primary` — a primary metric, something counted straight off a table.
 *   * `accent` — a computed metric: an aggregate over a period or a condition.
 *   * `danger` — something wrong that somebody has to act on.
 *
 * Every colour is a token class (`bg-accent`, `text-danger`, …). Nothing here
 * hardcodes a hex, and neither should a caller: a card whose tone does not fit
 * the vocabulary is a signal that the vocabulary needs a fourth entry, not that
 * this one screen needs an inline colour.
 */
const statCardAccentVariants = cva("h-[3px] w-full rounded-t-xl", {
	variants: {
		tone: {
			primary: "bg-primary",
			accent: "bg-accent-teal",
			danger: "bg-danger",
		},
	},
	defaultVariants: { tone: "primary" },
});

const statCardChipVariants = cva(
	"flex size-[34px] shrink-0 items-center justify-center rounded-md [&_svg]:size-[18px] [&_svg]:shrink-0",
	{
		variants: {
			tone: {
				primary: "bg-accent text-accent-foreground",
				accent: "bg-accent-teal-bg text-accent-teal",
				danger: "bg-danger-bg text-danger",
			},
		},
		defaultVariants: { tone: "primary" },
	},
);

type StatCardTone = NonNullable<
	VariantProps<typeof statCardAccentVariants>["tone"]
>;

function StatCardFrame({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="stat-card"
			className={cn(
				"flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)]",
				className,
			)}
			{...props}
		/>
	);
}

function StatCard({
	tone = "primary",
	icon,
	label,
	value,
	hint,
	className,
	...props
}: Omit<React.ComponentProps<"div">, "children"> & {
	tone?: StatCardTone;
	/** A Lucide stroke icon, sized by the chip. */
	icon: React.ReactNode;
	label: string;
	/**
	 * Already formatted. A card takes the string it should show rather than a
	 * number to format, so grouping and locale are decided once by the screen
	 * instead of differently by each card.
	 */
	value: string;
	/** One short line under the number — the period, the caveat, the unit. */
	hint?: string;
}) {
	return (
		<StatCardFrame className={className} {...props}>
			<div className={statCardAccentVariants({ tone })} />
			<div className="flex flex-col gap-3 p-4">
				<div className={statCardChipVariants({ tone })} aria-hidden="true">
					{icon}
				</div>
				<div className="flex flex-col gap-0.5">
					<span className="font-medium text-[12px] text-muted-foreground">
						{label}
					</span>
					{/* tabular-nums so a number changing between refetches does not
					    shuffle the label under it sideways. */}
					<span className="font-bold text-[24px] text-foreground tabular-nums leading-tight">
						{value}
					</span>
					{hint ? (
						<span className="text-[11px] text-text-tertiary">{hint}</span>
					) : null}
				</div>
			</div>
		</StatCardFrame>
	);
}

/**
 * A card with the number not yet in it.
 *
 * Keeps the accent bar and the card's real height, so the row does not reflow
 * when the request lands — the point of a skeleton is that the page stops
 * moving, not that something is pulsing.
 */
function StatCardSkeleton({
	tone = "primary",
	className,
	...props
}: Omit<React.ComponentProps<"div">, "children"> & { tone?: StatCardTone }) {
	return (
		<StatCardFrame className={className} {...props}>
			<div className={statCardAccentVariants({ tone })} />
			<div className="flex flex-col gap-3 p-4">
				<Skeleton className="size-[34px] rounded-md" />
				<div className="flex flex-col gap-1.5">
					<Skeleton className="h-3 w-24 rounded-sm" />
					<Skeleton className="h-6 w-14 rounded-sm" />
				</div>
			</div>
		</StatCardFrame>
	);
}

export { StatCard, StatCardSkeleton, type StatCardTone };
