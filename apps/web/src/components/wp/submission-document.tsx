"use client";

import { SUBMISSION_FIELD_LIMITS } from "@bfa-platform/api/lib/submission-field-limits";
import {
	OVERRIDDEN_FIELD_NOTE,
	overriddenFieldNames,
} from "@bfa-platform/api/lib/submission-overrides";
import {
	formatPsid,
	orderedWizardAnswers,
	type WizardAnswerField,
} from "@bfa-platform/api/lib/wizard-answer-layout";
import {
	ADP_KEY,
	ASSEMBLY_FIELD_KEYS,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	LINE_PRESSURE_KEY,
	OWNER_ABSENT_DISCLAIMER,
	SIGN_OFF_DISCLAIMER_KEY,
	valveYesWithReading,
	WATER_METER_END_KEY,
	WATER_METER_START_KEY,
	WIZARD_TEST_SPEC,
	type WizardQuestion,
} from "@bfa-platform/api/lib/wizard-input";
import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import { Card } from "@bfa-platform/ui/components/card";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import { DialogBody, DialogFooter } from "@bfa-platform/ui/components/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@bfa-platform/ui/components/empty";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import {
	SELECT_PLACEHOLDER,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bfa-platform/ui/components/select";
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import {
	useFormValidation,
	type ValidationRules,
} from "@bfa-platform/ui/hooks/use-form-validation";
import { cn } from "@bfa-platform/ui/lib/utils";
import {
	isoToUsDate,
	maxLength,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link2, PenLine, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { ResultDocumentButton } from "@/components/result-document-button";
import { TestPhotos } from "@/components/test-photos";
import {
	answerColumnClass,
	wizardChoiceLabel,
	wizardChoiceOptions,
} from "@/lib/wizard-answers";
import { trpc } from "@/utils/trpc";

import type {
	SubmissionBfaType,
	SubmissionDetail,
	SubmissionPayload,
	WizardValue,
} from "./submission-types";
import {
	BFA_TYPE_OPTIONS,
	binLabel,
	formatSubmissionDate,
	humanizeFieldName,
	parseWizardValue,
	READ_ONLY_NOTE,
	SIGNATURE_METHOD_LABELS,
	TEST_RESULT_LABELS,
	TEST_RESULT_VARIANTS,
	wizardEntries,
	wizardValueText,
} from "./submission-types";

/** Long enough that a typed BIN is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;
/** A short list under a search box, not a second paginated table. */
const ASSET_RESULT_LIMIT = 6;

/**
 * Base UI's `Select` has no value for "nothing chosen" that survives a round
 * trip — `null` is its placeholder state, not a selectable option — so the two
 * nullable selects below carry an explicit sentinel and convert at the edges.
 */
const NONE = "__none__";

/**
 * The correction form's state: the record as it is being edited.
 *
 * `wizardData` is held as its own object rather than flattened into the rest,
 * because its keys are the wizard's and vary per BFA type — the top-level
 * fields are columns and are known.
 */
type FormState = {
	bfaType: SubmissionBfaType;
	submittedBinText: string;
	testDate: string;
	testResult: string;
	signatureMethod: string;
	signatureData: string | null;
	wizardData: Record<string, WizardValue>;
};

function formStateOf(submission: SubmissionDetail): FormState {
	return {
		bfaType: submission.bfaType,
		submittedBinText: submission.submittedBinText ?? "",
		// Edited as displayed, `MM/DD/YYYY`; `payloadOf` converts it back.
		testDate: isoToUsDate(submission.testDate),
		testResult: submission.testResult ?? NONE,
		signatureMethod: submission.signatureMethod ?? NONE,
		signatureData: submission.signatureData,
		wizardData: Object.fromEntries(wizardEntries(submission.wizardData)),
	};
}

function payloadOf(id: string, form: FormState): SubmissionPayload {
	return {
		id,
		bfaType: form.bfaType,
		// Blank collapses to null on the server too; sending the empty string is
		// how "this field was cleared" is spelled on the wire.
		submittedBinText: form.submittedBinText,
		// Blank clears the date. A typed one goes out as the API's `YYYY-MM-DD`;
		// one that is not a real day is never sent by the Save button, and if it
		// were, it would go as typed for the server to refuse rather than blanked.
		testDate: form.testDate.trim()
			? (usDateToIso(form.testDate) ?? form.testDate)
			: null,
		testResult: form.testResult === NONE ? null : (form.testResult as "pass"),
		signatureMethod:
			form.signatureMethod === NONE ? null : (form.signatureMethod as "signed"),
		signatureData: form.signatureData,
		wizardData: form.wizardData,
	};
}

/**
 * One submitted test as the document it is, with every value editable in place.
 *
 * A document rather than a form, deliberately: § 6.6.6 asks for "a document-
 * style view of the full wizard result", and the reason is that a WP opening
 * one is usually reading it — checking a reading, answering a certifier's
 * phone call — not filling it in. So it reads top to bottom as the record, and
 * the fields happen to be editable rather than the record happening to be laid
 * out as a form.
 *
 * The per-BFA-type layout is deliberately not invented here. The results
 * document has one layout per type (§ 9), built as a shared frame plus a
 * swappable per-type test block, and that frame ships with the wizard (§ 6.5,
 * week 4). Until then the shared frame is what exists — header, test record,
 * answers, sign-off — and the answers section renders whatever `wizard_data`
 * actually holds. When the per-type blocks land, this is the section they
 * replace; nothing else here changes.
 */
export function SubmissionDocument({
	submission,
	canEdit,
	onChanged,
}: {
	submission: SubmissionDetail;
	canEdit: boolean;
	onChanged: () => Promise<void>;
}) {
	const [form, setForm] = useState<FormState>(() => formStateOf(submission));
	// A PSID reading shows one decimal place ("2.0") except while it is being
	// typed in — formatting under the cursor would fight the keystrokes, and
	// the stored value is never rewritten, so a save without edits stays a
	// no-op.
	const [focusedAnswer, setFocusedAnswer] = useState<string | null>(null);

	// The row can change underneath the form — a save returns the stored record,
	// and linking an asset refetches it. Re-seeding on the row's own identity
	// keeps the fields showing what was stored rather than what was typed at it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-seeds from the stored record, not on every keystroke
	useEffect(() => {
		setForm(formStateOf(submission));
	}, [submission.id, submission.updatedAt]);

	const overridden = overriddenFieldNames(submission.overriddenFields);

	const saveSubmission = useMutation(
		trpc.submittedTests.updateSubmittedTest.mutationOptions({
			onSuccess: async (row) => {
				// An unlinked test saved with a BIN registers a new asset from it
				// and comes back linked — worth saying, since the save did more
				// than correct the record.
				toast.success(
					!submission.bfaAssetId && row.bfaAssetId
						? `Asset ${row.bin} created and linked`
						: "Correction saved",
				);
				await onChanged();
			},
			// No toast on failure: a refused correction is reported in the footer,
			// beside the button that sent it, and stays there while it is fixed.
		}),
	);

	const bin = binLabel(submission);
	// In the PDF's order, with the spec's labels — see `wizard-answer-layout`.
	// Photos are not answers to correct; they are shown under the grid.
	const ordered = orderedWizardAnswers(
		form.bfaType,
		wizardEntries(form.wizardData),
		humanizeFieldName,
	);
	const answers = ordered.filter((answer) => answer.kind !== "photo");
	const answerGroups = groupAnswers(form.bfaType, answers);
	const photos = ordered.flatMap((answer) =>
		answer.kind === "photo" && typeof answer.value === "string"
			? [{ label: answer.label, path: answer.value }]
			: [],
	);
	const photoUrls = useQuery({
		...trpc.submittedTests.getPhotoUrls.queryOptions({ id: submission.id }),
		enabled: photos.length > 0,
		// Links live ten minutes; asking again on every render would be wasted.
		staleTime: 5 * 60 * 1000,
	});

	// The checkable values, flattened: the two typed columns plus every text or
	// number answer, keyed `answer:<field>` because the wizard's keys vary per
	// BFA type. Yes/no answers are selects with nothing to get wrong.
	const checked: Record<string, string> = {
		submittedBinText: form.submittedBinText,
		testDate: form.testDate,
	};
	const rules: ValidationRules<Record<string, string>> = {
		submittedBinText: maxLength(SUBMISSION_FIELD_LIMITS.submittedBinText),
		testDate: usDate(),
	};

	for (const { key, value } of answers) {
		// Selects have nothing to get wrong: a boolean, or a coded choice.
		if (typeof value === "boolean" || wizardChoiceOptions(key)) continue;

		checked[`answer:${key}`] = wizardValueText(value);
		rules[`answer:${key}`] = maxLength(
			SUBMISSION_FIELD_LIMITS.wizardValueLength,
			{ trim: false },
		);
	}

	const validation = useFormValidation({ values: checked, rules });

	function setField<Key extends keyof FormState>(
		key: Key,
		value: FormState[Key],
	) {
		setForm((current) => ({ ...current, [key]: value }));
	}

	/**
	 * Changes how the test was signed, and the sign-off with it, as the wizard
	 * writes them: owner absent carries the fixed disclaimer (never an image —
	 * the PDF prints that column as text), signed carries the owner's drawing
	 * — the one captured at the test, when there was one. The server applies
	 * the same rule on save, so this only keeps the screen honest.
	 */
	function changeSignOff(method: string) {
		const capturedImage =
			submission.signatureMethod === "signed" &&
			submission.signatureData?.startsWith("data:image/")
				? submission.signatureData
				: null;

		setForm((current) => {
			const { [SIGN_OFF_DISCLAIMER_KEY]: _disclaimer, ...answers } =
				current.wizardData;

			if (method === "owner_absent") {
				return {
					...current,
					signatureMethod: method,
					signatureData: OWNER_ABSENT_DISCLAIMER,
					wizardData: {
						...answers,
						[SIGN_OFF_DISCLAIMER_KEY]: OWNER_ABSENT_DISCLAIMER,
					},
				};
			}

			return {
				...current,
				signatureMethod: method,
				signatureData: method === "signed" ? capturedImage : null,
				wizardData: answers,
			};
		});
	}

	function setAnswer(key: string, value: WizardValue) {
		setForm((current) => ({
			...current,
			wizardData: { ...current.wizardData, [key]: value },
		}));
	}

	/** One answer as a labelled field — input, Yes/No select or coded choice. */
	function answerField(answer: Answer, className?: string) {
		const { key, value, label, kind } = answer;
		// A valve answer reads in the client's terms ("Tight" / "Leak"); any
		// other boolean stays Yes / No.
		const terms = answer.answers ?? { yes: "Yes", no: "No" };

		const choices = wizardChoiceOptions(key);
		const isSelect = typeof value === "boolean" || choices !== null;

		return (
			<Field
				key={key}
				className={className}
				label={label}
				id={isSelect ? undefined : validation.fieldId(`answer:${key}`)}
				error={
					isSelect ? null : (
						<FieldError {...validation.errorProps(`answer:${key}`)} />
					)
				}
				flagged={overridden.has(key)}
				readOnly={!canEdit}
				readOnlyValue={
					typeof value === "boolean"
						? value
							? terms.yes
							: terms.no
						: kind === "psid"
							? formatPsid(value) || "—"
							: wizardChoiceLabel(key, value) ||
								wizardValueText(value).trim() ||
								"—"
				}
			>
				{(id) =>
					choices ? (
						<ChoiceAnswerSelect
							id={id}
							choices={choices}
							value={value}
							onChange={(next) => setAnswer(key, next)}
						/>
					) : typeof value === "boolean" ? (
						<Select
							items={{ yes: terms.yes, no: terms.no }}
							value={value ? "yes" : "no"}
							onValueChange={(next) => setAnswer(key, next === "yes")}
						>
							<SelectTrigger id={id}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="yes">{terms.yes}</SelectItem>
									<SelectItem value="no">{terms.no}</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					) : (
						<Input
							{...validation.controlProps(`answer:${key}`)}
							id={id}
							value={
								kind === "psid" && focusedAnswer !== key
									? formatPsid(value)
									: wizardValueText(value)
							}
							onFocus={() => setFocusedAnswer(key)}
							onBlur={() => {
								setFocusedAnswer(null);
								validation.controlProps(`answer:${key}`).onBlur();
							}}
							inputMode={typeof value === "number" ? "decimal" : "text"}
							onChange={(event) =>
								setAnswer(key, parseWizardValue(value, event.target.value))
							}
						/>
					)
				}
			</Field>
		);
	}

	/**
	 * One valve as a row of the test table: the part, its answer in the
	 * client's terms ("Tight" / "Leak") and — where the part takes one and the
	 * first answer was chosen — the PSID reading, as the PDF prints it.
	 */
	function valveRow({ question, answer, reading }: ValveRowData) {
		const { label, answers: terms } = question;
		const flagged =
			overridden.has(question.key) ||
			Boolean(question.valueKey && overridden.has(question.valueKey));
		// Only with a Yes, as the wizard asks it and the PDF prints it: a "No"
		// takes no reading. A reading stored before the answer changed is kept,
		// not erased — switching back to Yes shows it again, as in the wizard.
		const showsReading = Boolean(question.valueKey) && answer?.value === true;

		return (
			<div
				key={question.key}
				className="grid grid-cols-1 items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_auto]"
			>
				<span className="flex flex-wrap items-center gap-2 font-semibold text-[13px]">
					{label}
					{flagged ? (
						<Badge variant="warning" title={OVERRIDDEN_FIELD_NOTE}>
							<PenLine aria-hidden="true" />
							Overwritten
						</Badge>
					) : null}
				</span>
				<span className="flex flex-wrap items-center gap-3">
					{canEdit ? (
						<Select
							items={{ yes: terms.yes, no: terms.no }}
							value={
								answer?.value === true
									? "yes"
									: answer?.value === false
										? "no"
										: null
							}
							onValueChange={(next) => setAnswer(question.key, next === "yes")}
						>
							<SelectTrigger aria-label={label} className="w-40">
								<SelectValue placeholder={SELECT_PLACEHOLDER} />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="yes">{terms.yes}</SelectItem>
									<SelectItem value="no">{terms.no}</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					) : (
						// The reading rides on the answer as one phrase, as the PDF
						// prints it: "Opened at 2.0 PSID", "Tight — 2.0 PSID".
						<span className="font-semibold text-[14px]">
							{answer?.value === true
								? valveYesWithReading(
										question,
										showsReading
											? formatPsid(reading?.value ?? null) || null
											: null,
									)
								: answer?.value === false
									? terms.no
									: "—"}
						</span>
					)}
					{showsReading && question.valueKey && canEdit ? (
						<span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
							<Input
								{...validation.controlProps(`answer:${question.valueKey}`)}
								aria-label={`${label} reading`}
								className="w-24"
								inputMode="decimal"
								value={
									focusedAnswer !== question.valueKey
										? formatPsid(reading?.value ?? null)
										: wizardValueText(reading?.value ?? null)
								}
								onFocus={() => setFocusedAnswer(question.valueKey ?? null)}
								onBlur={() => {
									setFocusedAnswer(null);
									validation
										.controlProps(`answer:${question.valueKey}`)
										.onBlur();
								}}
								onChange={(event) =>
									question.valueKey &&
									setAnswer(
										question.valueKey,
										parseWizardValue(
											reading?.value ?? null,
											event.target.value,
										),
									)
								}
							/>
							PSID
						</span>
					) : null}
				</span>
			</div>
		);
	}

	return (
		// A column that takes exactly the height its dialog hands it: the record
		// scrolls inside `DialogBody`, and the corrections bar sits below it in
		// `DialogFooter`, so Save stays on screen however long the record is.
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			<DialogBody>
				<DocumentHeader submission={submission} />

				{canEdit ? null : (
					<p className="rounded-md bg-muted px-3 py-2 text-[12px] text-muted-foreground">
						{READ_ONLY_NOTE}
					</p>
				)}

				{submission.bin ? null : (
					<LinkAssetPanel
						submission={submission}
						canEdit={canEdit}
						onChanged={onChanged}
					/>
				)}

				<Section title="Test record">
					<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
						<Field
							label="BFA type"
							flagged={overridden.has("bfaType")}
							readOnly={!canEdit}
							readOnlyValue={form.bfaType}
						>
							{(id) => (
								<Select
									items={BFA_TYPE_OPTIONS}
									value={form.bfaType}
									onValueChange={(value) =>
										setField("bfaType", value as SubmissionBfaType)
									}
								>
									<SelectTrigger id={id}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{Object.entries(BFA_TYPE_OPTIONS).map(
												([value, label]) => (
													<SelectItem key={value} value={value}>
														{label}
													</SelectItem>
												),
											)}
										</SelectGroup>
									</SelectContent>
								</Select>
							)}
						</Field>

						<Field
							label="Test date"
							id={validation.fieldId("testDate")}
							error={<FieldError {...validation.errorProps("testDate")} />}
							flagged={overridden.has("testDate")}
							readOnly={!canEdit}
							readOnlyValue={formatSubmissionDate(submission.testDate)}
						>
							{() => (
								<DateInput
									pickerLabel="Choose test date"
									{...validation.controlProps("testDate")}
									value={form.testDate}
									onValueChange={(value) => setField("testDate", value)}
								/>
							)}
						</Field>

						<Field
							label="Result"
							flagged={overridden.has("testResult")}
							readOnly={!canEdit}
							readOnlyValue={
								submission.testResult
									? TEST_RESULT_LABELS[submission.testResult]
									: "—"
							}
						>
							{(id) => (
								<Select
									items={{
										[NONE]: "Not recorded",
										pass: TEST_RESULT_LABELS.pass,
										fail: TEST_RESULT_LABELS.fail,
									}}
									value={form.testResult}
									onValueChange={(value) =>
										setField("testResult", value as string)
									}
								>
									<SelectTrigger id={id}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectItem value={NONE}>Not recorded</SelectItem>
											<SelectItem value="pass">
												{TEST_RESULT_LABELS.pass}
											</SelectItem>
											<SelectItem value="fail">
												{TEST_RESULT_LABELS.fail}
											</SelectItem>
										</SelectGroup>
									</SelectContent>
								</Select>
							)}
						</Field>

						<Field
							label={
								submission.bfaAssetId
									? "BIN as the certifier typed it"
									: "BIN the certifier typed"
							}
							id={validation.fieldId("submittedBinText")}
							error={
								<FieldError {...validation.errorProps("submittedBinText")} />
							}
							flagged={overridden.has("submittedBinText")}
							readOnly={!canEdit}
							readOnlyValue={form.submittedBinText || "—"}
							hint={
								submission.bfaAssetId && !submission.bin
									? "Linked to a new asset with no BIN yet — assign its BIN on the asset's page."
									: submission.bfaAssetId
										? `Linked to ${bin.text}. This records what was written on the day.`
										: canEdit
											? "For a new assembly, enter the BIN you are giving it. Saving creates the asset from this test and links them."
											: undefined
							}
						>
							{() => (
								<>
									<Input
										{...validation.controlProps("submittedBinText")}
										value={form.submittedBinText}
										onChange={(event) =>
											setField("submittedBinText", event.target.value)
										}
									/>
									{submission.bfaAssetId ? null : (
										<BinMatchNotice
											submissionId={submission.id}
											bin={
												form.submittedBinText.trim() !==
												(submission.submittedBinText ?? "")
													? form.submittedBinText.trim()
													: ""
											}
											onChanged={onChanged}
										/>
									)}
								</>
							)}
						</Field>
					</div>
				</Section>

				{/* The answers, in the results PDF's sections — see
				    `wizard-answer-layout` for the order and the labels. */}
				{answers.length === 0 ? (
					<Section title="Test answers">
						<p className="text-[13px] text-muted-foreground">
							This submission carries no recorded answers.
						</p>
					</Section>
				) : (
					<>
						{groupHas(answerGroups.assembly) ? (
							<Section title="Assembly information">
								<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
									{answerGroups.assembly.map((answer) => answerField(answer))}
								</div>
							</Section>
						) : null}

						{groupHas(answerGroups.customer) ? (
							<Section title="Customer information">
								<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
									{answerGroups.customer.map((answer) => answerField(answer))}
								</div>
							</Section>
						) : null}

						{groupHas(answerGroups.readings) ||
						answerGroups.valveSections.some(
							(section) => section.rows.length > 0,
						) ? (
							<Section title={`Initial test — ${form.bfaType}`}>
								{groupHas(answerGroups.readings) ? (
									<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
										{answerGroups.readings.map((answer) =>
											answerField(
												answer,
												answerColumnClass(answer.column, true),
											),
										)}
									</div>
								) : null}
								{answerGroups.valveSections.map((section) =>
									section.rows.length > 0 ? (
										<div
											key={section.title ?? "test"}
											className="flex flex-col gap-2"
										>
											{section.title ? (
												<p className="font-bold text-[12px] text-primary uppercase tracking-wide">
													{section.title}
												</p>
											) : null}
											<div className="divide-y divide-border rounded-md border border-border">
												{section.rows.map((row) => valveRow(row))}
											</div>
										</div>
									) : null,
								)}
							</Section>
						) : null}

						{groupHas(answerGroups.outcome) ? (
							<Section title="Property isolation and result">
								<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
									{answerGroups.outcome.map((answer) => answerField(answer))}
								</div>
							</Section>
						) : null}

						{groupHas(answerGroups.comment) ? (
							<Section title="Comment">
								{answerGroups.comment.map((answer) => answerField(answer))}
							</Section>
						) : null}

						{groupHas(answerGroups.other) ? (
							<Section
								title="Other answers"
								description="Recorded by the wizard but not part of this type's form."
							>
								<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
									{answerGroups.other.map((answer) => answerField(answer))}
								</div>
							</Section>
						) : null}
					</>
				)}

				{photos.length > 0 ? (
					<Section title="Photos">
						<TestPhotos photos={photos} urls={photoUrls.data ?? {}} />
					</Section>
				) : null}

				<Section title="Sign-off">
					<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
						<Field
							label="How it was signed"
							flagged={overridden.has("signatureMethod")}
							readOnly={!canEdit}
							readOnlyValue={
								submission.signatureMethod
									? SIGNATURE_METHOD_LABELS[submission.signatureMethod]
									: "—"
							}
						>
							{(id) => (
								// Required in the wizard, so no "Not recorded": a purveyor can
								// change how it was signed but not clear it. A row with none
								// stored (older than the wizard) shows the placeholder.
								<Select
									items={SIGNATURE_METHOD_LABELS}
									value={
										form.signatureMethod === NONE ? null : form.signatureMethod
									}
									onValueChange={(value) => {
										if (typeof value === "string") changeSignOff(value);
									}}
								>
									<SelectTrigger id={id}>
										<SelectValue placeholder={SELECT_PLACEHOLDER} />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{Object.entries(SIGNATURE_METHOD_LABELS).map(
												([value, label]) => (
													<SelectItem key={value} value={value}>
														{label}
													</SelectItem>
												),
											)}
										</SelectGroup>
									</SelectContent>
								</Select>
							)}
						</Field>

						{/* What the sign-off is follows how it was signed: the owner's
						    drawing, or the fixed disclaimer — never both. */}
						{form.signatureMethod === "signed" ? (
							<Signature
								value={form.signatureData}
								canEdit={canEdit}
								onClear={() => setField("signatureData", null)}
							/>
						) : form.signatureMethod === "owner_absent" ? (
							<div className="flex flex-col gap-1">
								<span className="text-[12px] text-muted-foreground">
									Disclaimer
								</span>
								<p className="rounded-md bg-muted px-3 py-2 text-[13px]">
									{OWNER_ABSENT_DISCLAIMER}
								</p>
							</div>
						) : null}
					</div>
				</Section>
			</DialogBody>

			{canEdit ? (
				<DialogFooter className="flex-row flex-wrap items-center justify-end border-border border-t pt-4">
					<FormError
						className="basis-full"
						message={
							saveSubmission.isError ? saveSubmission.error.message : null
						}
					/>
					<p className="mr-auto text-[12px] text-muted-foreground">
						Saving records you as the last person to correct this test.
					</p>
					<Button
						variant="secondary"
						size="sm"
						disabled={saveSubmission.isPending}
						onClick={() => {
							setForm(formStateOf(submission));
							validation.reset();
						}}
					>
						Reset
					</Button>
					<Button
						size="sm"
						disabled={saveSubmission.isPending}
						onClick={() => {
							if (!validation.validate()) return;

							saveSubmission.mutate(payloadOf(submission.id, form));
						}}
					>
						<PenLine />
						{saveSubmission.isPending ? "Saving…" : "Save corrections"}
					</Button>
				</DialogFooter>
			) : null}
		</div>
	);
}

/**
 * A coded wizard answer — the initial test's Pass/Fail, or "isolates the
 * entire property" — as a dropdown of exactly the choices the wizard's buttons
 * offered. Both are required in the wizard, so there is no "not recorded"
 * option: a WP can change the answer but not clear it. An empty value (only
 * possible on a row older than the wizard) shows the placeholder, and a stored
 * value the wizard never offers is kept as its own option rather than silently
 * replaced by the first choice.
 */
function ChoiceAnswerSelect({
	id,
	choices,
	value,
	onChange,
}: {
	id: string;
	choices: Record<string, string>;
	value: WizardValue;
	onChange: (value: string) => void;
}) {
	const current = typeof value === "string" && value ? value : null;
	const items: Record<string, string> =
		current && !(current in choices)
			? { [current]: current, ...choices }
			: choices;

	return (
		<Select
			items={items}
			value={current}
			onValueChange={(next) => {
				if (typeof next === "string") onChange(next);
			}}
		>
			<SelectTrigger id={id}>
				<SelectValue placeholder={SELECT_PLACEHOLDER} />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					{Object.entries(items).map(([option, label]) => (
						<SelectItem key={option} value={option}>
							{label}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}

/**
 * Checks a BIN the purveyor is typing into an unlinked test against their own
 * assets. Saving a new BIN registers a new asset, so a BIN that already exists
 * is the one case that must go the other way: the test belongs to that asset,
 * and is linked to it rather than saved (the server refuses the save anyway).
 * Linking here keeps the purveyor from having to find the same BIN again in
 * the list above.
 *
 * Only for a BIN changed in this edit — `bin` is empty otherwise — and
 * debounced, so typing is one request rather than one per keystroke.
 */
function BinMatchNotice({
	submissionId,
	bin,
	onChanged,
}: {
	submissionId: string;
	bin: string;
	onChanged: () => Promise<void>;
}) {
	const [appliedBin, setAppliedBin] = useState(bin);

	useEffect(() => {
		const timer = setTimeout(() => setAppliedBin(bin), SEARCH_DEBOUNCE_MS);

		return () => clearTimeout(timer);
	}, [bin]);

	const matches = useQuery({
		...trpc.assets.listAssets.queryOptions({
			page: 1,
			pageSize: ASSET_RESULT_LIMIT,
			search: appliedBin || undefined,
		}),
		enabled: Boolean(appliedBin),
	});
	const linkAsset = useMutation(
		trpc.submittedTests.linkSubmissionAsset.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`Linked to ${row.bin}`);
				await onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const match = appliedBin
		? matches.data?.rows.find((asset) => asset.bin === appliedBin)
		: undefined;

	if (!match) return null;

	return (
		<div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning-bg px-3 py-2 text-[12px]">
			<span>
				BIN {match.bin} is already an asset — {match.bfaType} ·{" "}
				{match.serviceAddress}. Link this test to it instead of saving.
			</span>
			<Button
				size="sm"
				variant="secondary"
				disabled={linkAsset.isPending}
				onClick={() => linkAsset.mutate({ submissionId, assetId: match.id })}
			>
				<Link2 />
				Link
			</Button>
		</div>
	);
}

/** The record's identity: who filed it, against what, and how it came out. */
function DocumentHeader({ submission }: { submission: SubmissionDetail }) {
	const bin = binLabel(submission);
	const getDocumentUrl = useMutation(
		trpc.submittedTests.getResultDocumentUrl.mutationOptions(),
	);

	return (
		<div className="flex flex-wrap items-start justify-between gap-3 border-border border-b pb-4">
			<div className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-bold text-[18px]">{bin.text}</span>
					{bin.resolved ? null : (
						<Badge variant="warning">
							<TriangleAlert aria-hidden="true" />
							Not linked to an asset
						</Badge>
					)}
					{submission.testResult ? (
						<Badge variant={TEST_RESULT_VARIANTS[submission.testResult]}>
							{TEST_RESULT_LABELS[submission.testResult]}
						</Badge>
					) : null}
				</div>
				<p className="text-[13px] text-muted-foreground">
					{submission.bfaType} · tested{" "}
					{formatSubmissionDate(submission.testDate)} by{" "}
					{submission.certifierName}
					{submission.serviceAddress ? ` · ${submission.serviceAddress}` : ""}
				</p>
			</div>

			<div className="flex flex-col items-end gap-2">
				{submission.editedByWpProfileId ? (
					<Badge variant="neutral">Corrected by this purveyor</Badge>
				) : null}
				<ResultDocumentButton
					fetchUrl={async () =>
						(await getDocumentUrl.mutateAsync({ id: submission.id })).url
					}
				/>
			</div>
		</div>
	);
}

/**
 * The unresolved-BIN resolution step.
 *
 * The certifier may leave the BIN blank and fill in the rest of the form; which
 * assembly it belongs to is the purveyor's to work out afterward (PRD § 9,
 * "Empty-BIN wizard entry"). This is that step, and it is at the top of the
 * document rather than beside the BIN field because until it is answered, every
 * other value on the page is attached to nothing.
 *
 * The search reads `assets.listAssets`, which is WP-scoped, so there is no
 * other purveyor's asset to pick in the first place — and `linkSubmissionAsset`
 * checks tenancy again anyway, because a control that cannot offer the wrong
 * answer is not the same thing as a procedure that would refuse one.
 */
function LinkAssetPanel({
	submission,
	canEdit,
	onChanged,
}: {
	submission: SubmissionDetail;
	canEdit: boolean;
	onChanged: () => Promise<void>;
}) {
	const searchId = useId();
	const [search, setSearch] = useState(submission.submittedBinText ?? "");
	const [appliedSearch, setAppliedSearch] = useState(search.trim());

	useEffect(() => {
		const timer = setTimeout(
			() => setAppliedSearch(search.trim()),
			SEARCH_DEBOUNCE_MS,
		);

		return () => clearTimeout(timer);
	}, [search]);

	const assets = useQuery(
		trpc.assets.listAssets.queryOptions({
			page: 1,
			pageSize: ASSET_RESULT_LIMIT,
			search: appliedSearch || undefined,
		}),
	);

	const linkAsset = useMutation(
		trpc.submittedTests.linkSubmissionAsset.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`Linked to ${row.bin}`);
				await onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	// Only numbered assets: linking to another no-BIN one would number nothing.
	const rows = (assets.data?.rows ?? []).filter((asset) => asset.bin);
	// Submitted since the wizard registers a no-BIN asset for a test with no
	// BIN; before that, the test was left unlinked.
	const noBinAssetId = submission.bfaAssetId;

	return (
		<Card className="flex flex-col gap-3 border-warning/30 bg-warning-bg/40 p-4">
			<div className="flex flex-col gap-1">
				<h3 className="flex items-center gap-1.5 font-bold text-[14.5px]">
					<Link2 className="size-4" aria-hidden="true" />
					{noBinAssetId
						? "This test has no BIN"
						: "This test is not linked to an asset"}
				</h3>
				{noBinAssetId ? (
					<p className="text-[12px] text-muted-foreground">
						The certifier had no BIN, so a new asset was registered without one.{" "}
						{canEdit ? (
							<>
								If the assembly is already registered, link the test to it below
								— the empty asset is removed. Otherwise{" "}
								<Link
									href={`/wp/assets/${noBinAssetId}`}
									className="text-primary hover:underline"
								>
									assign the new asset its BIN
								</Link>
								.
							</>
						) : (
							READ_ONLY_NOTE
						)}
					</p>
				) : (
					<p className="text-[12px] text-muted-foreground">
						{submission.submittedBinText
							? `The certifier typed “${submission.submittedBinText}”, which matched no assembly.`
							: "The certifier left the BIN blank."}{" "}
						{canEdit
							? "Find the assembly it belongs to and attach it — or, for a new assembly, enter its BIN under Test record and save."
							: READ_ONLY_NOTE}
					</p>
				)}
			</div>

			{canEdit ? (
				<>
					<div className="relative">
						<Search
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-tertiary"
							aria-hidden="true"
						/>
						<Input
							id={searchId}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search your assets by BIN or service address"
							aria-label="Search your assets by BIN or service address"
							type="search"
							autoComplete="off"
							className="pl-8"
						/>
					</div>

					{assets.isPending ? (
						<Skeleton className="h-16 rounded-md" />
					) : rows.length === 0 ? (
						<p className="text-[12px] text-muted-foreground">
							No assets match that search.
						</p>
					) : (
						<ul className="flex flex-col gap-1.5">
							{rows.map((asset) => (
								<li
									key={asset.id}
									className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2"
								>
									<span className="flex flex-col">
										<span className="font-semibold text-[13px]">
											{asset.bin}
										</span>
										<span className="text-[12px] text-muted-foreground">
											{asset.bfaType} · {asset.serviceAddress}
										</span>
									</span>
									<Button
										variant="secondary"
										size="sm"
										disabled={linkAsset.isPending}
										onClick={() =>
											linkAsset.mutate({
												submissionId: submission.id,
												assetId: asset.id,
											})
										}
									>
										{linkAsset.isPending &&
										linkAsset.variables?.assetId === asset.id
											? "Linking…"
											: "Link"}
									</Button>
								</li>
							))}
						</ul>
					)}
				</>
			) : null}
		</Card>
	);
}

/**
 * The stored signature.
 *
 * Shown, not typed into. A signature is a drawing the property owner made on a
 * phone; the correction a purveyor actually makes to one is removing a
 * signature that should not be there and recording the owner-absent bypass
 * instead, which is the control beside it. A text box over image bytes would
 * offer an edit nobody wants and every accidental keystroke would corrupt.
 */
function Signature({
	value,
	canEdit,
	onClear,
}: {
	value: string | null;
	canEdit: boolean;
	onClear: () => void;
}) {
	const isImage = Boolean(value?.startsWith("data:image/"));

	return (
		<div className="flex flex-col gap-1">
			<span className="text-[12px] text-muted-foreground">Signature</span>
			{value ? (
				<div className="flex flex-col items-start gap-2">
					{isImage ? (
						// biome-ignore lint/performance/noImgElement: a data: URI the row carries, not an asset Next can optimise
						<img
							src={value}
							alt="The signature captured at the test"
							className="max-h-24 rounded-md border border-border bg-card p-1"
						/>
					) : (
						<p className="break-all rounded-md bg-muted px-3 py-2 text-[12px] text-muted-foreground">
							{value}
						</p>
					)}
					{canEdit ? (
						<Button variant="ghost" size="sm" onClick={onClear}>
							Remove signature
						</Button>
					) : null}
				</div>
			) : (
				<p className="text-[14px] text-foreground">Not captured</p>
			)}
		</div>
	);
}

/** One titled block of the document. */
type Answer = WizardAnswerField & { value: WizardValue };

type ValveRowData = {
	question: WizardQuestion;
	answer: Answer | undefined;
	reading: Answer | undefined;
};

/**
 * The stored answers sorted into the results PDF's sections. Only answers the
 * test holds are placed (a valve row appears when either its Yes/No or its
 * reading is stored); anything the form for this type does not ask lands in
 * `other`, so nothing a certifier recorded disappears from the screen.
 */
function groupAnswers(bfaType: SubmissionBfaType, answers: Answer[]) {
	const byKey = new Map(answers.map((answer) => [answer.key, answer]));
	const placed = new Set<string>();
	const take = (keys: string[]) =>
		keys.flatMap((key) => {
			const answer = byKey.get(key);
			if (!answer) return [];
			placed.add(key);
			return [answer];
		});

	const assembly = take(Object.values(ASSEMBLY_FIELD_KEYS));
	const customer = take([CUSTOMER_NAME_KEY, CUSTOMER_EMAIL_KEY]);
	const readings = take([
		LINE_PRESSURE_KEY,
		ADP_KEY,
		WATER_METER_START_KEY,
		WATER_METER_END_KEY,
	]);
	const valveSections = WIZARD_TEST_SPEC[bfaType].sections.map((section) => ({
		title: section.title,
		rows: section.questions.flatMap((question): ValveRowData[] => {
			const answer = byKey.get(question.key);
			const reading = question.valueKey
				? byKey.get(question.valueKey)
				: undefined;

			if (!answer && !reading) return [];

			placed.add(question.key);
			if (question.valueKey) placed.add(question.valueKey);

			return [{ question, answer, reading }];
		}),
	}));
	const outcome = take([ISOLATES_PROPERTY_KEY, INITIAL_TEST_KEY]);
	const comment = take(["comments"]);
	const signOff = take([SIGN_OFF_DISCLAIMER_KEY]);
	const other = answers.filter((answer) => !placed.has(answer.key));

	return {
		assembly,
		customer,
		readings,
		valveSections,
		outcome,
		comment,
		signOff,
		other,
	};
}

function groupHas(group: Answer[]) {
	return group.length > 0;
}

function Section({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		// Boxed and headed as the results PDF and the certifier's document are.
		<section className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:p-4">
			<div className="flex flex-col gap-0.5">
				<h3 className="font-bold text-[13px] text-primary uppercase tracking-wide">
					{title}
				</h3>
				{description ? (
					<p className="text-[12px] text-muted-foreground">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}

/**
 * One labelled value, editable or not, with the overridden marker beside its
 * label when the certifier typed over a prefilled value.
 *
 * The marker is on the label rather than inside the control, so it survives the
 * read-only rendering an Employee sees — a flag that only appears next to an
 * input would be invisible to exactly the people who cannot change the value
 * and therefore most need to know it was changed.
 */
function Field({
	label,
	id: controlId,
	error,
	flagged,
	readOnly,
	readOnlyValue,
	hint,
	className,
	children,
}: {
	label: string;
	/** The control's id when a validation hook owns it; generated otherwise. */
	id?: string;
	/** The field's inline error, rendered directly under the control. */
	error?: React.ReactNode;
	flagged: boolean;
	readOnly: boolean;
	readOnlyValue: string;
	hint?: string;
	/** Where the field sits in its grid row — see `answerColumnClass`. */
	className?: string;
	children: (id: string) => React.ReactNode;
}) {
	const generatedId = useId();
	const id = controlId ?? generatedId;

	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<div className="flex flex-wrap items-center gap-2">
				<Label htmlFor={id} className="text-[12px] text-muted-foreground">
					{label}
				</Label>
				{flagged ? (
					<Badge variant="warning" title={OVERRIDDEN_FIELD_NOTE}>
						<PenLine aria-hidden="true" />
						Overwritten by the certifier
					</Badge>
				) : null}
			</div>

			{readOnly ? (
				<p className="text-[14px] text-foreground">{readOnlyValue || "—"}</p>
			) : (
				<>
					{children(id)}
					{error}
				</>
			)}

			{hint ? (
				<p className="text-[11px] text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

/** The document's own loading and error frames, used by the dialog above it. */
export function SubmissionDocumentSkeleton() {
	return (
		<div className="flex flex-col gap-4">
			<Skeleton className="h-12 w-full rounded-md" />
			<Skeleton className="h-32 w-full rounded-md" />
			<Skeleton className="h-32 w-full rounded-md" />
		</div>
	);
}

export function SubmissionDocumentError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<TriangleAlert className="text-danger" />
				</EmptyMedia>
				<EmptyTitle>Couldn&rsquo;t load this test</EmptyTitle>
				<EmptyDescription>{message}</EmptyDescription>
			</EmptyHeader>
			<Button variant="secondary" size="sm" onClick={onRetry}>
				Try again
			</Button>
		</Empty>
	);
}
