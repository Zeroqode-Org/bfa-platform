/**
 * Shared types for the certifier wizard's own components. Kept local to the
 * wizard rather than imported from `@/components/wp/submission-types` —
 * that module's own comment gives the reason to keep the certifier and WP
 * screens decoupled, and the wizard is the third side of that same triangle.
 */

/** One wizard answer: a scalar or nothing. Never a nested document — matches the server's `wizardDataInput`. */
export type WizardValue = string | number | boolean | null;

export type WizardValues = Record<string, WizardValue>;

/**
 * The eight assembly types, in the order the PRD and the wizard list them.
 * Shown as the bare code everywhere — the client does not want each type
 * spelled out (October 2026).
 */
export const BFA_TYPE_OPTIONS = {
	RP: "RP",
	RPDA: "RPDA",
	"RPDA-2": "RPDA-2",
	DC: "DC",
	DCDA: "DCDA",
	"DCDA-2": "DCDA-2",
	PVB: "PVB",
	SVB: "SVB",
} satisfies Record<string, string>;

export type BfaType = keyof typeof BFA_TYPE_OPTIONS;

/** Each type's bare code ("RPDA-2"), as the select's items. */
export const BFA_TYPE_CODES = Object.fromEntries(
	Object.keys(BFA_TYPE_OPTIONS).map((code) => [code, code]),
) as Record<BfaType, BfaType>;

/** The six types that take ADP and Line Pressure ahead of their test block; PVB/SVB take Line Pressure only. */
export const PRESSURE_ZONE_TYPES: BfaType[] = [
	"RP",
	"RPDA",
	"RPDA-2",
	"DC",
	"DCDA",
	"DCDA-2",
];
