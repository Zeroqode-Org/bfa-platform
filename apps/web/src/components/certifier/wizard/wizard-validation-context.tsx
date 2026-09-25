"use client";

import { createContext, useContext } from "react";

/**
 * What the screen currently marks as missing. `showErrors` only turns on after
 * the certifier tries to continue with something lacking, so a fresh screen
 * does not open covered in red; from then on the marks are live and clear as
 * each field is filled.
 */
type ValidationState = { showErrors: boolean; missing: Set<string> };

const ValidationContext = createContext<ValidationState>({
	showErrors: false,
	missing: new Set(),
});

export const WizardValidationProvider = ValidationContext.Provider;

/** The message to show under a field, or null while it is fine or errors are not yet shown. */
export function useFieldError(fieldKey: string | undefined): string | null {
	const { showErrors, missing } = useContext(ValidationContext);

	if (!fieldKey || !showErrors || !missing.has(fieldKey)) return null;

	if (fieldKey === "bin") {
		return "Look this BIN up, or clear it to enter the assembly by hand";
	}
	if (fieldKey === "customerEmail") return "Enter a valid email address";

	return "Required";
}
