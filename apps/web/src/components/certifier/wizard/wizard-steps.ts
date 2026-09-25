import { WIZARD_TEST_SPEC } from "@bfa-platform/api/lib/wizard-input";

import type { BfaType } from "./wizard-types";

/**
 * The wizard's screens for one BFA type: identification, assembly, then one
 * test screen per section of that type's test (RP, DC, PVB and SVB have one;
 * the detector types have a main test and a bypass, so two), then the Initial
 * Test result on a screen of its own, then closing and a final review. The count depends on the type, which is settled on the
 * first screen.
 */
export type StepKind =
	| { kind: "identification" }
	| { kind: "assembly" }
	| { kind: "test"; page: number }
	| { kind: "result" }
	| { kind: "closing" }
	| { kind: "review" };

export function testPageCount(bfaType: BfaType): number {
	return Math.max(1, WIZARD_TEST_SPEC[bfaType].sections.length);
}

export function stepCount(bfaType: BfaType): number {
	return 5 + testPageCount(bfaType);
}

export function stepKind(step: number, bfaType: BfaType): StepKind {
	const total = stepCount(bfaType);

	if (step <= 1) return { kind: "identification" };
	if (step === 2) return { kind: "assembly" };
	if (step >= total) return { kind: "review" };
	if (step === total - 1) return { kind: "closing" };
	if (step === total - 2) return { kind: "result" };

	return { kind: "test", page: step - 3 };
}

/** The step number of the first screen of a given kind, for "Edit" links from the review. */
export function stepNumberOf(kind: StepKind["kind"], bfaType: BfaType): number {
	switch (kind) {
		case "identification":
			return 1;
		case "assembly":
			return 2;
		case "test":
			return 3;
		case "result":
			return stepCount(bfaType) - 2;
		case "closing":
			return stepCount(bfaType) - 1;
		case "review":
			return stepCount(bfaType);
	}
}

export function stepLabels(bfaType: BfaType): string[] {
	const { sections } = WIZARD_TEST_SPEC[bfaType];
	const test =
		sections.length > 1
			? // "DA TEST #2 — BYPASS ASSEMBLY" → "DA TEST #2"
				sections.map((section) => section.title?.split(" — ")[0] ?? "Test")
			: ["Test"];

	return ["Identification", "Assembly", ...test, "Result", "Closing", "Review"];
}
