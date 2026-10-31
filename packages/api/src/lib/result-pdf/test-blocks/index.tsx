import { Path, Svg, Text, View } from "@react-pdf/renderer";
import { formatPsid } from "../../wizard-answer-layout";
import {
	ADP_KEY,
	LINE_PRESSURE_KEY,
	LINE_PRESSURE_UNIT,
	PRESSURE_DIFFERENCE_UNIT,
	valveYesWithReading,
	WATER_METER_END_KEY,
	WATER_METER_END_LABEL,
	WATER_METER_START_KEY,
	WATER_METER_START_LABEL,
	WIZARD_TEST_SPEC,
	type WizardQuestion,
} from "../../wizard-input";
import { COLORS, pdfStyles, textValue } from "../pdf-styles";

type BfaType = keyof typeof WIZARD_TEST_SPEC;

/** A reading with its unit, or a dash when nothing was entered. */
function withUnit(value: unknown, unit: string): string {
	const text = textValue(value);

	return text === "—" ? text : `${text} ${unit}`;
}

/** One label-over-value cell of a ruled row. */
export function Cell({
	label,
	value,
	highlight,
}: {
	label: string;
	value: string;
	highlight?: boolean;
}) {
	return (
		<View style={[pdfStyles.cell, highlight ? pdfStyles.cellHighlight : {}]}>
			<Text style={pdfStyles.label}>{label}</Text>
			<Text style={pdfStyles.value}>{value}</Text>
		</View>
	);
}

/** A ruled table of cells. */
export function Table({ children }: { children: React.ReactNode }) {
	return (
		<View style={pdfStyles.table}>
			<View style={pdfStyles.row}>{children}</View>
		</View>
	);
}

/**
 * A box with a check mark when chosen, empty otherwise — drawn, because the
 * PDF's fonts carry no check glyph. The client's sheet asks for a check mark
 * or an X in the box, not a filled square.
 */
export function Check({ checked, label }: { checked: boolean; label: string }) {
	return (
		<View style={pdfStyles.check}>
			<View style={[pdfStyles.box, checked ? pdfStyles.boxOn : {}]}>
				{checked ? (
					<Svg width={7} height={7} viewBox="0 0 10 10">
						<Path
							d="M1.5 5.2 L4 7.7 L8.7 2.3"
							stroke={COLORS.page}
							strokeWidth={1.8}
							fill="none"
						/>
					</Svg>
				) : null}
			</View>
			<Text style={checked ? pdfStyles.checkTextOn : pdfStyles.checkText}>
				{label}
			</Text>
		</View>
	);
}

function AnswerRow({
	entry,
	wizardData,
}: {
	entry: WizardQuestion;
	wizardData: Record<string, unknown>;
}) {
	const answer = wizardData[entry.key];
	// The reading rides on the chosen answer as one phrase — "Opened at 2.0
	// PSID", "Tight — Check held at 2.0 PSID" — the way the paper form reads.
	const reading =
		entry.valueKey && answer === true
			? formatPsid(wizardData[entry.valueKey]) || null
			: null;

	return (
		<View style={pdfStyles.answerRow} wrap={false}>
			<Text style={pdfStyles.answerLabel}>{entry.label}</Text>
			<View style={pdfStyles.checks}>
				<Check
					checked={answer === true}
					label={
						answer === true
							? valveYesWithReading(entry, reading)
							: entry.answers.yes
					}
				/>
				<Check checked={answer === false} label={entry.answers.no} />
			</View>
		</View>
	);
}

/**
 * The body of the "Initial test" section for one BFA type, drawn from the same
 * `WIZARD_TEST_SPEC` the wizard's screens and the server-side validation read —
 * so the document shows exactly the questions the certifier was asked, in the
 * order they were asked, under the same headings. Line pressure and ADP sit in
 * one ruled row (ADP highlighted, the RP family only), the water meter pair
 * follows for the detector types, then each test section's valve rows.
 */
export function TestBlockForTypePdf({
	bfaType,
	wizardData,
}: {
	bfaType: BfaType;
	wizardData: Record<string, unknown>;
}) {
	const spec = WIZARD_TEST_SPEC[bfaType];

	return (
		<View>
			<Table>
				<Cell
					label="Line pressure"
					value={withUnit(wizardData[LINE_PRESSURE_KEY], LINE_PRESSURE_UNIT)}
				/>
				{spec.hasAdp ? (
					<Cell
						label="Apparent differential pressure (ADP)"
						value={withUnit(wizardData[ADP_KEY], PRESSURE_DIFFERENCE_UNIT)}
						highlight
					/>
				) : null}
				{spec.hasMeter ? (
					<>
						<Cell
							label={WATER_METER_START_LABEL}
							value={textValue(wizardData[WATER_METER_START_KEY])}
						/>
						<Cell
							label={WATER_METER_END_LABEL}
							value={textValue(wizardData[WATER_METER_END_KEY])}
						/>
					</>
				) : null}
			</Table>

			{spec.sections.map((section) => (
				<View key={section.title ?? "test"}>
					{section.title ? (
						<Text style={pdfStyles.subTitle}>{section.title}</Text>
					) : null}
					<View style={[pdfStyles.table, { marginBottom: 0 }]}>
						{section.questions.map((entry) => (
							<AnswerRow
								key={entry.key}
								entry={entry}
								wizardData={wizardData}
							/>
						))}
					</View>
				</View>
			))}
		</View>
	);
}
