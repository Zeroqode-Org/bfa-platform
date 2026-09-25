"use client";

import { WizardField } from "../wizard-field";
import type { WizardValues } from "../wizard-types";
import { IsolatesButtons } from "./choice-buttons";

const QUESTION = "Does this assembly isolate the entire property?";

/**
 * The one field every BFA type ends its test with (`ISOLATES_PROPERTY_KEY`
 * on the server).
 */
export function IsolatesPropertyField({
	values,
	onChange,
	overridden,
}: {
	values: WizardValues;
	onChange: (key: string, value: WizardValues[string]) => void;
	overridden: Set<string>;
}) {
	return (
		<WizardField
			label={QUESTION}
			required
			fieldKey="isolatesEntireProperty"
			flagged={overridden.has("isolatesEntireProperty")}
		>
			{() => (
				<IsolatesButtons
					label={QUESTION}
					value={values.isolatesEntireProperty as string | null}
					onValueChange={(value) => onChange("isolatesEntireProperty", value)}
				/>
			)}
		</WizardField>
	);
}
