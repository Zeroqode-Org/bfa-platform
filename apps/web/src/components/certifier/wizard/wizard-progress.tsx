import { cn } from "@bfa-platform/ui/lib/utils";

/**
 * Thin rounded segments, one per step, filled `#1588C1` through the current
 * step and the same primary at half opacity beyond it — the design
 * system's own "Wizard progress" spec — with a 12px muted step label
 * underneath (build-plan § 6.5 step 4). Past the last label is the review
 * preview, which is not a step: every segment is filled and the label says
 * the wizard is done.
 */
export function WizardProgress({
	step,
	labels,
}: {
	step: number;
	labels: string[];
}) {
	const isPreview = step > labels.length;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-1.5">
				{labels.map((label, index) => (
					<div
						key={label}
						className={cn(
							"h-[5px] flex-1 rounded-full bg-primary",
							index + 1 > step && "opacity-50",
						)}
					/>
				))}
			</div>
			<p className="text-[12px] text-muted-foreground">
				{isPreview
					? "Preview — check the form, then submit it or save it to Drafts"
					: `Step ${step} of ${labels.length} — ${labels[step - 1]}`}
			</p>
		</div>
	);
}
