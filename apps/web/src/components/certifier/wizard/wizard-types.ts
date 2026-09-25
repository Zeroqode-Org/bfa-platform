/**
 * Shared types for the certifier wizard's own components. Kept local to the
 * wizard rather than imported from `@/components/wp/submission-types` —
 * that module's own comment gives the reason to keep the certifier and WP
 * screens decoupled, and the wizard is the third side of that same triangle.
 */

/** One wizard answer: a scalar or nothing. Never a nested document — matches the server's `wizardDataInput`. */
export type WizardValue = string | number | boolean | null;

export type WizardValues = Record<string, WizardValue>;

/** The eight assembly types, in the order the PRD and the wizard list them. */
export const BFA_TYPE_OPTIONS = {
	RP: "RP — Reduced Pressure Zone Assembly",
	RPDA: "RPDA — RP Detector Assembly",
	"RPDA-2": "RPDA-2 — Double RP Detector Assembly",
	DC: "DC — Double Check Assembly",
	DCDA: "DCDA — DC Detector Assembly",
	"DCDA-2": "DCDA-2 — Double DC Detector Assembly",
	PVB: "PVB — Pressure Vacuum Breaker",
	SVB: "SVB — Spill-Resistant Vacuum Breaker",
} satisfies Record<string, string>;

export type BfaType = keyof typeof BFA_TYPE_OPTIONS;

/** The six types that take ADP and Line Pressure ahead of their test block; PVB/SVB take Line Pressure only. */
export const PRESSURE_ZONE_TYPES: BfaType[] = [
	"RP",
	"RPDA",
	"RPDA-2",
	"DC",
	"DCDA",
	"DCDA-2",
];
