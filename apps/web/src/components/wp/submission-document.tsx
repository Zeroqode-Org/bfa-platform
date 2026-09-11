"use client";

import { SUBMISSION_FIELD_LIMITS } from "@bfa-platform/api/lib/submission-field-limits";
import {
	OVERRIDDEN_FIELD_NOTE,
	overriddenFieldNames,
} from "@bfa-platform/api/lib/submission-overrides";
import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import { Card } from "@bfa-platform/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@bfa-platform/ui/components/empty";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bfa-platform/ui/components/select";
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link2, PenLine, Search, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

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
		testDate: submission.testDate ?? "",
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
		testDate: form.testDate || null,
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
			onSuccess: async () => {
				toast.success("Correction saved");
				await onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const bin = binLabel(submission);
	const answers = wizardEntries(form.wizardData);

	function setField<Key extends keyof FormState>(
		key: Key,
		value: FormState[Key],
	) {
		setForm((current) => ({ ...current, [key]: value }));
	}

	function setAnswer(key: string, value: WizardValue) {
		setForm((current) => ({
			...current,
			wizardData: { ...current.wizardData, [key]: value },
		}));
	}

	return (
		<div className="flex flex-col gap-4">
			<DocumentHeader submission={submission} />

			{canEdit ? null : (
				<p className="rounded-md bg-muted px-3 py-2 text-[12px] text-muted-foreground">
					{READ_ONLY_NOTE}
				</p>
			)}

			{submission.bfaAssetId ? null : (
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
										{Object.entries(BFA_TYPE_OPTIONS).map(([value, label]) => (
											<SelectItem key={value} value={value}>
												{label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						)}
					</Field>

					<Field
						label="Test date"
						flagged={overridden.has("testDate")}
						readOnly={!canEdit}
						readOnlyValue={formatSubmissionDate(submission.testDate)}
					>
						{(id) => (
							<Input
								id={id}
								type="date"
								value={form.testDate}
								onChange={(event) => setField("testDate", event.target.value)}
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
						flagged={overridden.has("submittedBinText")}
						readOnly={!canEdit}
						readOnlyValue={form.submittedBinText || "—"}
						hint={
							submission.bfaAssetId
								? `Linked to ${bin.text}. This records what was written on the day.`
								: undefined
						}
					>
						{(id) => (
							<Input
								id={id}
								value={form.submittedBinText}
								maxLength={SUBMISSION_FIELD_LIMITS.submittedBinText}
								onChange={(event) =>
									setField("submittedBinText", event.target.value)
								}
							/>
						)}
					</Field>
				</div>
			</Section>

			<Section
				title="Test answers"
				description="What the certifier recorded, as the wizard stored it."
			>
				{answers.length === 0 ? (
					<p className="text-[13px] text-muted-foreground">
						This submission carries no recorded answers.
					</p>
				) : (
					<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
						{answers.map(([key, value]) => (
							<Field
								key={key}
								label={humanizeFieldName(key)}
								flagged={overridden.has(key)}
								readOnly={!canEdit}
								readOnlyValue={
									typeof value === "boolean"
										? value
											? "Yes"
											: "No"
										: wizardValueText(value) || "—"
								}
							>
								{(id) =>
									typeof value === "boolean" ? (
										<Select
											items={{ yes: "Yes", no: "No" }}
											value={value ? "yes" : "no"}
											onValueChange={(next) => setAnswer(key, next === "yes")}
										>
											<SelectTrigger id={id}>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectItem value="yes">Yes</SelectItem>
													<SelectItem value="no">No</SelectItem>
												</SelectGroup>
											</SelectContent>
										</Select>
									) : (
										<Input
											id={id}
											value={wizardValueText(value)}
											inputMode={typeof value === "number" ? "decimal" : "text"}
											maxLength={SUBMISSION_FIELD_LIMITS.wizardValueLength}
											onChange={(event) =>
												setAnswer(
													key,
													parseWizardValue(value, event.target.value),
												)
											}
										/>
									)
								}
							</Field>
						))}
					</div>
				)}
			</Section>

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
							<Select
								items={{
									[NONE]: "Not recorded",
									...SIGNATURE_METHOD_LABELS,
								}}
								value={form.signatureMethod}
								onValueChange={(value) =>
									setField("signatureMethod", value as string)
								}
							>
								<SelectTrigger id={id}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										<SelectItem value={NONE}>Not recorded</SelectItem>
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

					<Signature
						value={form.signatureData}
						canEdit={canEdit}
						onClear={() => setField("signatureData", null)}
					/>
				</div>
			</Section>

			{canEdit ? (
				<div className="flex flex-wrap items-center justify-end gap-2 border-border border-t pt-4">
					<p className="mr-auto text-[12px] text-muted-foreground">
						Saving records you as the last person to correct this test.
					</p>
					<Button
						variant="secondary"
						size="sm"
						disabled={saveSubmission.isPending}
						onClick={() => setForm(formStateOf(submission))}
					>
						Reset
					</Button>
					<Button
						size="sm"
						disabled={saveSubmission.isPending}
						onClick={() =>
							saveSubmission.mutate(payloadOf(submission.id, form))
						}
					>
						<PenLine />
						{saveSubmission.isPending ? "Saving…" : "Save corrections"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/** The record's identity: who filed it, against what, and how it came out. */
function DocumentHeader({ submission }: { submission: SubmissionDetail }) {
	const bin = binLabel(submission);

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

			{submission.editedByWpProfileId ? (
				<Badge variant="neutral">Corrected by this purveyor</Badge>
			) : null}
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

	const rows = assets.data?.rows ?? [];

	return (
		<Card className="flex flex-col gap-3 border-warning/30 bg-warning-bg/40 p-4">
			<div className="flex flex-col gap-1">
				<h3 className="flex items-center gap-1.5 font-bold text-[14.5px]">
					<Link2 className="size-4" aria-hidden="true" />
					This test is not linked to an asset
				</h3>
				<p className="text-[12px] text-muted-foreground">
					{submission.submittedBinText
						? `The certifier typed “${submission.submittedBinText}”, which matched no assembly.`
						: "The certifier left the BIN blank."}{" "}
					{canEdit
						? "Find the assembly it belongs to and attach it."
						: READ_ONLY_NOTE}
				</p>
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
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-0.5">
				<h3 className="font-bold text-[15.5px]">{title}</h3>
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
	flagged,
	readOnly,
	readOnlyValue,
	hint,
	children,
}: {
	label: string;
	flagged: boolean;
	readOnly: boolean;
	readOnlyValue: string;
	hint?: string;
	children: (id: string) => React.ReactNode;
}) {
	const id = useId();

	return (
		<div className="flex flex-col gap-1.5">
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
				children(id)
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
