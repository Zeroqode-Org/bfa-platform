"use client";

import {
	type NoticeVariable,
	placeholderFor,
	renderTemplate,
	templateTextError,
	variableKeys,
} from "@bfa-platform/api/lib/notice-variables";
import { Button } from "@bfa-platform/ui/components/button";
import { FormError } from "@bfa-platform/ui/components/field-message";
import { TriangleAlert } from "lucide-react";
import { useCallback, useRef } from "react";

import type { NoticeSampleValues } from "./notice-types";

/**
 * The notice-template editor's variable reference panel, its preview, and the
 * caret handling that puts a placeholder where somebody was typing — plus the
 * error strip and read-only sentence the general-info broadcast shares with it.
 * The broadcast uses none of the variable pieces: it is sent as literal text.
 *
 * Neither variable piece names a variable. Both take the list they are given,
 * so a seventh variable is an entry in `NOTICE_VARIABLES`.
 */

/**
 * Tracks which of a composer's two text fields was last focused and inserts a
 * placeholder at its caret.
 *
 * Inserting at the caret rather than appending is what makes the panel usable
 * mid-sentence: "Hello ▍, your test is due" is where the name goes. The subject
 * is the fallback only when nothing has been focused yet and the body is the
 * likelier target, so the default is the body.
 *
 * The insert goes through `onChange` with the new string rather than writing to
 * `element.value` directly, so React state stays the single source of truth for
 * what is in the field.
 */
export function useVariableInsertion({
	onInsertSubject,
	onInsertBody,
}: {
	onInsertSubject: (next: string) => void;
	onInsertBody: (next: string) => void;
}) {
	const subjectRef = useRef<HTMLInputElement>(null);
	const bodyRef = useRef<HTMLTextAreaElement>(null);
	const lastFocused = useRef<"subject" | "body">("body");

	const onSubjectFocus = useCallback(() => {
		lastFocused.current = "subject";
	}, []);
	const onBodyFocus = useCallback(() => {
		lastFocused.current = "body";
	}, []);

	const insert = useCallback(
		(placeholder: string) => {
			const field =
				lastFocused.current === "subject"
					? subjectRef.current
					: bodyRef.current;
			const apply =
				lastFocused.current === "subject" ? onInsertSubject : onInsertBody;

			if (!field) return;

			const start = field.selectionStart ?? field.value.length;
			const end = field.selectionEnd ?? start;
			const next =
				field.value.slice(0, start) + placeholder + field.value.slice(end);

			apply(next);

			// After React has written the new value, put the caret past what was
			// inserted so typing continues where the person was rather than at the
			// end of the field.
			requestAnimationFrame(() => {
				field.focus();
				const caret = start + placeholder.length;
				field.setSelectionRange(caret, caret);
			});
		},
		[onInsertBody, onInsertSubject],
	);

	return { subjectRef, bodyRef, onSubjectFocus, onBodyFocus, insert };
}

/**
 * The placeholders this composer supports, each one a button that writes it
 * into the field being edited.
 *
 * Rendered from the list, never from six hardcoded chips. The placeholder text
 * is shown as well as the label, because it is what somebody typing by hand has
 * to reproduce exactly.
 */
export function VariableReferencePanel({
	variables,
	onInsert,
	disabled = false,
	description,
}: {
	variables: readonly NoticeVariable[];
	onInsert: (placeholder: string) => void;
	disabled?: boolean;
	description?: string;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border-soft bg-muted/40 p-3">
			<div className="flex flex-col gap-0.5">
				<p className="font-semibold text-[12px] text-foreground">
					Dynamic values
				</p>
				<p className="text-[12px] text-muted-foreground">
					{description ??
						"Each is replaced with the record's own value when the message is sent."}
				</p>
			</div>

			<ul className="flex flex-wrap gap-1.5">
				{variables.map((variable) => (
					<li key={variable.key}>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={disabled}
							title={variable.description}
							// The accessible name has to say what pressing this does — the
							// visible text is the placeholder, which reads as a value.
							aria-label={`Insert ${placeholderFor(variable.key)} — ${variable.label}`}
							onClick={() => onInsert(placeholderFor(variable.key))}
						>
							<span className="font-mono text-[11px]">
								{placeholderFor(variable.key)}
							</span>
							<span className="text-muted-foreground">{variable.label}</span>
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Subject and body as the recipient would read them, with the sample values
 * substituted.
 *
 * Both are shown, labelled, because a subject line with a placeholder left in
 * it is the mistake most easily missed. Text only — `renderTemplate` returns a
 * string and it is rendered as one, never as markup, exactly as the send path
 * escapes it.
 *
 * Anything the substitution could not resolve stays visible as `{{…}}`, and the
 * warning below says so rather than leaving it to be spotted.
 */
export function TemplatePreview({
	subject,
	body,
	values,
	variables,
}: {
	subject: string;
	body: string;
	values: NoticeSampleValues;
	variables: readonly NoticeVariable[];
}) {
	const allowed = variableKeys(variables);
	const renderedSubject = renderTemplate(subject, values, allowed);
	const renderedBody = renderTemplate(body, values, allowed);
	const problem =
		templateTextError(subject, allowed) ?? templateTextError(body, allowed);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
				<div className="flex flex-col gap-0.5">
					<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
						Subject
					</span>
					<p className="font-semibold text-[13px] text-foreground">
						{renderedSubject || "—"}
					</p>
				</div>

				<div className="flex flex-col gap-0.5 border-border-soft border-t pt-2">
					<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
						Message
					</span>
					<p className="whitespace-pre-wrap text-[13px] text-foreground">
						{renderedBody || "—"}
					</p>
				</div>
			</div>

			{problem ? (
				<p
					role="alert"
					className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{problem}
				</p>
			) : (
				<p className="text-[12px] text-muted-foreground">
					Preview uses sample values. Each recipient gets their own.
				</p>
			)}
		</div>
	);
}

/**
 * The inline error strip both composers use for a refused save or send — the
 * shared form-level pattern, never a toast.
 */
export function ComposerError({ message }: { message: string }) {
	return <FormError message={message} />;
}

/**
 * The one sentence explaining why the write controls are missing, for the two
 * WP roles that read this screen without editing it.
 */
export const READ_ONLY_NOTICE =
	"Your role can read notice settings. Only a WP Admin can edit a template or send a broadcast.";
