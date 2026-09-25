"use client";

import { OVERRIDDEN_FIELD_NOTE } from "@bfa-platform/api/lib/submission-overrides";
import { Badge } from "@bfa-platform/ui/components/badge";
import { Label } from "@bfa-platform/ui/components/label";
import { cn } from "@bfa-platform/ui/lib/utils";
import { PenLine } from "lucide-react";
import { useId } from "react";

import { useFieldError } from "./wizard-validation-context";

/**
 * One labelled wizard control.
 *
 * `readOnly` renders the flat-tint, secondary-text styling build-plan § 6.5
 * step 10 asks for on a prefilled assembly field — same layout as an
 * editable one, never a second screen. `flagged` shows the same "overwritten
 * by the certifier" marker `submission-document.tsx` uses on the WP side, so
 * a certifier can see, while still in the wizard, which of their edits will
 * carry that flag once submitted.
 */
export function WizardField({
	label,
	id: controlId,
	hint,
	readOnly,
	readOnlyValue,
	flagged,
	required,
	fieldKey,
	className,
	children,
}: {
	label: string;
	id?: string;
	hint?: string;
	readOnly?: boolean;
	readOnlyValue?: string;
	flagged?: boolean;
	/** Marks the field as required with an asterisk; enforcement lives in `wizard-validation.ts` and on the server. */
	required?: boolean;
	/** Ties the field to `wizard-validation.ts`, so a missing answer is marked and scrolled to. */
	fieldKey?: string;
	className?: string;
	children?: (id: string) => React.ReactNode;
}) {
	const generatedId = useId();
	const id = controlId ?? generatedId;
	const error = useFieldError(fieldKey);

	return (
		<div
			data-invalid={error ? "true" : undefined}
			className={cn("flex scroll-mt-44 flex-col gap-1.5", className)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Label htmlFor={id} className="text-[12px] text-muted-foreground">
					{label}
					{required ? (
						<span className="ml-0.5 text-danger" aria-hidden="true">
							*
						</span>
					) : null}
				</Label>
				{flagged ? (
					<Badge variant="warning" title={OVERRIDDEN_FIELD_NOTE}>
						<PenLine aria-hidden="true" />
						Overwritten by the certifier
					</Badge>
				) : null}
			</div>

			{readOnly ? (
				<p className="rounded-md bg-muted px-3 py-2 text-[14px] text-muted-foreground">
					{readOnlyValue || "—"}
				</p>
			) : (
				children?.(id)
			)}

			{error ? (
				<p role="alert" className="text-[12px] text-danger">
					{error}
				</p>
			) : null}

			{hint ? (
				<p className="text-[11px] text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}
