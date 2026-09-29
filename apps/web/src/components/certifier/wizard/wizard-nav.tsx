"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { cn } from "@bfa-platform/ui/lib/utils";
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Save } from "lucide-react";

/**
 * Back / Save to Draft / Next — or, on the review preview, just Save to
 * Draft and Submit: the wizard is finished by then, so there is no Back.
 * Rendered twice by the shell: as a
 * bar pinned to the top on phones, where the bottom of a long test screen is
 * a scroll away, and as the usual footer from the desktop breakpoint up —
 * each hides itself at the other's width, so exactly one shows.
 */
export function WizardNav({
	className,
	isFirst,
	isLast,
	nextLabel,
	saving,
	savingKind,
	submitting,
	onBack,
	onSave,
	onNext,
	onSubmit,
}: {
	className?: string;
	isFirst: boolean;
	/** The review preview: Save draft and Submit only. */
	isLast: boolean;
	/** "Next", or "Preview" on the screen before the review. */
	nextLabel: string;
	saving: boolean;
	savingKind: "save" | "next";
	submitting: boolean;
	onBack: () => void;
	onSave: () => void;
	onNext: () => void;
	onSubmit: () => void;
}) {
	return (
		<div
			className={cn(
				"items-center gap-2 min-[780px]:justify-between",
				className,
			)}
		>
			{isLast ? null : (
				<Button
					variant="secondary"
					className="h-10 flex-1 min-[780px]:flex-none"
					disabled={isFirst}
					onClick={onBack}
				>
					<ArrowLeft aria-hidden="true" />
					Back
				</Button>
			)}
			{/* Phone: the buttons share the row equally. Desktop: Back on the left, Save and Next together on the right. */}
			<div className="contents min-[780px]:ml-auto min-[780px]:flex min-[780px]:gap-2">
				<Button
					variant="secondary"
					className="h-10 flex-1 min-[780px]:flex-none"
					disabled={saving}
					onClick={onSave}
				>
					{saving && savingKind === "save" ? (
						<LoaderCircle className="animate-spin" aria-hidden="true" />
					) : (
						<Save aria-hidden="true" />
					)}
					{saving && savingKind === "save" ? "Saving…" : "Save draft"}
				</Button>
				{isLast ? (
					<Button
						className="h-10 flex-1 min-[780px]:flex-none"
						disabled={submitting || saving}
						onClick={onSubmit}
					>
						{submitting ? (
							<LoaderCircle className="animate-spin" aria-hidden="true" />
						) : (
							<Check aria-hidden="true" />
						)}
						{submitting ? "Submitting…" : "Submit"}
					</Button>
				) : (
					<Button
						className="h-10 flex-1 min-[780px]:flex-none"
						disabled={saving}
						onClick={onNext}
					>
						{nextLabel}
						{saving && savingKind === "next" ? (
							<LoaderCircle className="animate-spin" aria-hidden="true" />
						) : (
							<ArrowRight aria-hidden="true" />
						)}
					</Button>
				)}
			</div>
		</div>
	);
}
