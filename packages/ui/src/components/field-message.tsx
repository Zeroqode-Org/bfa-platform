import { cn } from "@bfa-platform/ui/lib/utils";
import { TriangleAlert } from "lucide-react";

/**
 * The one inline error pattern every form uses.
 *
 * `FieldError` sits directly under its control and is referenced from the
 * control's `aria-describedby`, so the message is read when the field is
 * focused as well as announced (`role="alert"`) when it appears or changes.
 * Renders nothing without a message, so the reference only exists while there
 * is something to point at — `useFormValidation` wires both ends.
 *
 * Field problems are never toasts: a toast disappears, sits away from the
 * field, and cannot be reached again once the person tabs back to fix it.
 */
function FieldError({
	id,
	message,
	className,
}: {
	id: string;
	message?: string | null;
	className?: string;
}) {
	if (!message) return null;

	return (
		<p
			id={id}
			role="alert"
			data-slot="field-error"
			className={cn(
				"flex items-start gap-1.5 text-[12px] text-danger leading-snug",
				className,
			)}
		>
			<TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
			{message}
		</p>
	);
}

/**
 * A refusal that belongs to the whole form rather than one field — a
 * permission error, a not-found, a failed sign-in.
 */
function FormError({
	message,
	id,
	className,
}: {
	message?: string | null;
	id?: string;
	className?: string;
}) {
	if (!message) return null;

	return (
		<p
			id={id}
			role="alert"
			data-slot="form-error"
			className={cn(
				"flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger",
				className,
			)}
		>
			<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
			{message}
		</p>
	);
}

/**
 * Characters used against a server-defined maximum, for long-text controls
 * only. Deliberately not a live region — announcing every keystroke would
 * drown out the text being typed; going over the limit is announced by the
 * field's own error instead.
 */
function FieldCounter({
	id,
	length,
	max,
	className,
}: {
	id: string;
	length: number;
	max: number;
	className?: string;
}) {
	const over = length > max;

	return (
		<p
			id={id}
			data-slot="field-counter"
			data-over={over ? "" : undefined}
			className={cn(
				"text-right text-[11px] text-muted-foreground tabular-nums",
				over && "text-danger",
				className,
			)}
		>
			{length.toLocaleString("en-US")} / {max.toLocaleString("en-US")}{" "}
			characters
		</p>
	);
}

export { FieldCounter, FieldError, FormError };
