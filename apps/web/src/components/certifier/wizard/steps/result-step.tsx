"use client";

import { Card, CardContent } from "@bfa-platform/ui/components/card";

import { PassFailButtons } from "../test-blocks/choice-buttons";
import { WizardField } from "../wizard-field";
import type { WizardValues } from "../wizard-types";

/**
 * The Initial Test result, on a screen of its own once every reading is in —
 * the one judgement the whole test rests on, made last, with the readings
 * fresh, and it is also the submission's overall result.
 */
export function ResultStep({
	values,
	overridden,
	onAnswer,
}: {
	values: WizardValues;
	overridden: Set<string>;
	onAnswer: (key: string, value: WizardValues[string]) => void;
}) {
	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<p className="text-[13px] text-muted-foreground">
					With every reading entered, did this assembly pass its initial test?
				</p>
				<WizardField
					label="Initial test"
					required
					fieldKey="initialTestResult"
					flagged={overridden.has("initialTestResult")}
				>
					{() => (
						<PassFailButtons
							label="Initial test"
							value={values.initialTestResult as string | null}
							onValueChange={(value) => onAnswer("initialTestResult", value)}
						/>
					)}
				</WizardField>
			</CardContent>
		</Card>
	);
}
