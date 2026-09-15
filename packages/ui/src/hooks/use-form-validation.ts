"use client";

import { useId, useState } from "react";
import { flushSync } from "react-dom";

/** Checks one field against the whole form, so a rule can depend on a sibling (a date range, a conditional field). */
export type FieldValidator<Value, Values> = (
	value: Value,
	values: Values,
) => string | undefined;

export type ValidationRules<Values> = {
	[Name in keyof Values]?: FieldValidator<Values[Name], Values>;
};

export type FieldErrors<Values> = Partial<Record<keyof Values, string>>;

const NO_FIELDS: ReadonlySet<never> = new Set();

/**
 * Per-field inline validation for a form whose values live in React state.
 *
 * The form keeps owning its values; this hook owns only *which* errors are on
 * screen. Messages are derived from the current values on every render rather
 * than stored, so a message can never outlive the value it was about — typing
 * a correction clears it on the same keystroke, and there is no effect to keep
 * in step.
 *
 * Timing:
 * - Nothing is shown when the form opens.
 * - Leaving a field that was changed reveals its message.
 * - `validate()` (on submit) reveals every failing field and focuses the first
 *   one in document order.
 * - Once revealed, a field stays revealed: its message follows the value until
 *   the value is correct, and comes back if it is broken again.
 *
 * `externalErrors` are messages from the server that belong to a field — shown
 * at that field, with the same ARIA wiring, whenever the field's own rules pass.
 *
 * Ids are generated here, so the label, the control and its message cannot
 * disagree about which element is which: pass `fieldId(name)` to `<Label
 * htmlFor>` and spread `controlProps(name)` onto the control.
 */
export function useFormValidation<Values extends object>({
	values,
	rules,
	initialValues,
	externalErrors,
}: {
	values: Values;
	rules: ValidationRules<Values>;
	/**
	 * What "changed" is measured against for reveal-on-blur. Defaults to the
	 * values at mount; pass it when one hook instance edits several records in
	 * turn (and call `reset()` when switching).
	 */
	initialValues?: Values;
	externalErrors?: FieldErrors<Values>;
}) {
	const baseId = useId();
	const [mountedValues] = useState(values);
	const [shown, setShown] = useState<ReadonlySet<keyof Values>>(NO_FIELDS);
	const reference = initialValues ?? mountedValues;
	const names = Object.keys(rules) as (keyof Values)[];

	function ruleError(name: keyof Values) {
		return rules[name]?.(values[name], values);
	}

	const errors: FieldErrors<Values> = {};

	for (const name of names) {
		const message = shown.has(name) ? ruleError(name) : undefined;
		if (message) errors[name] = message;
	}

	if (externalErrors) {
		for (const name of Object.keys(externalErrors) as (keyof Values)[]) {
			const message = externalErrors[name];
			if (message && !errors[name]) errors[name] = message;
		}
	}

	function fieldId(name: keyof Values) {
		return `${baseId}-${String(name).replace(/[^\w-]/g, "_")}`;
	}

	function errorId(name: keyof Values) {
		return `${fieldId(name)}-error`;
	}

	function reveal(fields: readonly (keyof Values)[]) {
		setShown((current) =>
			fields.every((field) => current.has(field))
				? current
				: new Set([...current, ...fields]),
		);
	}

	/**
	 * Reveals every failing field and focuses the first, returning whether the
	 * form may be sent.
	 *
	 * The reveal is flushed before focus moves, so by the time a screen reader
	 * announces the focused control it already carries `aria-invalid` and points
	 * at its message.
	 */
	function validate() {
		const invalid = names.filter((name) => ruleError(name));

		if (invalid.length === 0) return true;

		flushSync(() => reveal(invalid));

		const first = invalid
			.map((name) => document.getElementById(fieldId(name)))
			.filter((element): element is HTMLElement => element !== null)
			.sort((a, b) =>
				a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
					? -1
					: 1,
			)[0];

		first?.focus();

		return false;
	}

	/** Hides every message — for a form reused for a different record. */
	function reset() {
		setShown(NO_FIELDS);
	}

	/** Props for the control: its id, invalid state, message linkage and reveal-on-blur. */
	function controlProps(
		name: keyof Values,
		{ describedBy }: { describedBy?: string | false | null } = {},
	) {
		const error = errors[name];
		const describers = [error ? errorId(name) : null, describedBy || null]
			.filter(Boolean)
			.join(" ");

		return {
			id: fieldId(name),
			"aria-invalid": error ? (true as const) : undefined,
			"aria-describedby": describers || undefined,
			onBlur: () => {
				if (!Object.is(values[name], reference[name])) reveal([name]);
			},
		};
	}

	/** Props for the `FieldError` beside the control. */
	function errorProps(name: keyof Values) {
		return { id: errorId(name), message: errors[name] };
	}

	return {
		errors,
		fieldId,
		errorId,
		controlProps,
		errorProps,
		validate,
		reset,
	};
}
