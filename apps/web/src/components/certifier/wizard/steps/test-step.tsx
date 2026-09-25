"use client";

import {
	ADP_KEY,
	LINE_PRESSURE_KEY,
	LINE_PRESSURE_UNIT,
	PRESSURE_DIFFERENCE_UNIT,
	WATER_METER_END_KEY,
	WATER_METER_START_KEY,
	WIZARD_TEST_SPEC,
	type WizardQuestion,
} from "@bfa-platform/api/lib/wizard-input";
import { Card, CardContent } from "@bfa-platform/ui/components/card";
import { Input } from "@bfa-platform/ui/components/input";
import { YesNoButtons } from "../test-blocks/choice-buttons";
import { IsolatesPropertyField } from "../test-blocks/isolates-property-field";
import { UnitInput } from "../test-blocks/unit-input";
import { WizardField } from "../wizard-field";
import type { BfaType, WizardValues } from "../wizard-types";

type Props = {
	bfaType: BfaType;
	/** Which section this screen shows; the first also carries the opening readings, the last the closing ones. */
	page: number;
	values: WizardValues;
	overridden: Set<string>;
	onAnswer: (key: string, value: WizardValues[string]) => void;
};

/**
 * Step 3 — everything the sheet asks between the assembly details and the
 * closing block, in the sheet's order: ADP and Line Pressure, the water meter
 * start (detector types), the test sections, the water meter end and the
 * isolates-the-property answer. The Initial Test follows on its own screen.
 *
 * Built entirely from `WIZARD_TEST_SPEC`, the same description the server
 * validates against and the PDF prints from, so no BFA type is a component of
 * its own here.
 */
export function TestStep({
	bfaType,
	page,
	values,
	overridden,
	onAnswer,
}: Props) {
	const spec = WIZARD_TEST_SPEC[bfaType];
	const first = page === 0;
	const last = page >= spec.sections.length - 1;
	const text = (key: string) => (values[key] as string) ?? "";

	return (
		<Card>
			<CardContent className="flex flex-col gap-5">
				{first ? (
					<>
						<div
							className={
								spec.hasAdp ? "grid gap-x-6 gap-y-4 sm:grid-cols-2" : undefined
							}
						>
							{spec.hasAdp ? (
								<WizardField label="ADP (optional)">
									{(id) => (
										<UnitInput
											id={id}
											unit={PRESSURE_DIFFERENCE_UNIT}
											placeholder="0.0"
											value={text(ADP_KEY)}
											onChange={(event) =>
												onAnswer(ADP_KEY, event.target.value)
											}
										/>
									)}
								</WizardField>
							) : null}
							<WizardField label="Line pressure (optional)">
								{(id) => (
									<UnitInput
										id={id}
										unit={LINE_PRESSURE_UNIT}
										placeholder="0"
										value={text(LINE_PRESSURE_KEY)}
										onChange={(event) =>
											onAnswer(LINE_PRESSURE_KEY, event.target.value)
										}
									/>
								)}
							</WizardField>
						</div>

						{spec.hasMeter ? (
							<WizardField
								label="Water meter start"
								required
								fieldKey={WATER_METER_START_KEY}
							>
								{(id) => (
									<Input
										id={id}
										inputMode="decimal"
										value={text(WATER_METER_START_KEY)}
										onChange={(event) =>
											onAnswer(WATER_METER_START_KEY, event.target.value)
										}
									/>
								)}
							</WizardField>
						) : null}
					</>
				) : null}

				{spec.sections.map((section, index) =>
					index === page ? (
						<section
							key={section.title ?? "test"}
							className="flex flex-col gap-4"
						>
							{section.title ? (
								<h3 className="font-bold text-[15px]">{section.title}</h3>
							) : null}
							{section.questions.map((entry) => (
								<Question
									key={entry.key}
									entry={entry}
									values={values}
									overridden={overridden}
									onAnswer={onAnswer}
								/>
							))}
						</section>
					) : null,
				)}

				{last ? (
					<>
						{spec.hasMeter ? (
							<WizardField
								label="Water meter end"
								required
								fieldKey={WATER_METER_END_KEY}
							>
								{(id) => (
									<Input
										id={id}
										inputMode="decimal"
										value={text(WATER_METER_END_KEY)}
										onChange={(event) =>
											onAnswer(WATER_METER_END_KEY, event.target.value)
										}
									/>
								)}
							</WizardField>
						) : null}

						<div className="border-border border-t pt-4">
							<IsolatesPropertyField
								values={values}
								onChange={onAnswer}
								overridden={overridden}
							/>
						</div>
					</>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * One Yes/No question. Answering Yes adds its value input beside it — the two
 * share the row — because the sheet's "If Yes → Value" only exists then.
 */
function Question({
	entry,
	values,
	overridden,
	onAnswer,
}: {
	entry: WizardQuestion;
	values: WizardValues;
	overridden: Set<string>;
	onAnswer: Props["onAnswer"];
}) {
	const { key, label, valueKey } = entry;
	const answeredYes = values[key] === true;

	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
			<WizardField
				label={label}
				required
				fieldKey={key}
				className="flex-1"
				flagged={overridden.has(key)}
			>
				{() => (
					<YesNoButtons
						label={label}
						value={values[key] as boolean | null}
						onValueChange={(value) => onAnswer(key, value)}
					/>
				)}
			</WizardField>
			{valueKey && answeredYes ? (
				<WizardField
					label={entry.valueLabel ?? "Value"}
					required
					fieldKey={valueKey}
					className="flex-1"
					flagged={overridden.has(valueKey)}
				>
					{(id) => (
						<UnitInput
							id={id}
							unit={PRESSURE_DIFFERENCE_UNIT}
							placeholder="0.0"
							value={(values[valueKey] as string) ?? ""}
							onChange={(event) => onAnswer(valueKey, event.target.value)}
						/>
					)}
				</WizardField>
			) : null}
		</div>
	);
}
