"use client";

import {
	ADP_KEY,
	ASSEMBLY_FIELD_KEYS,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	LINE_PRESSURE_KEY,
	PHOTO_PATH_KEYS,
	WATER_METER_END_KEY,
	WATER_METER_START_KEY,
	wizardQuestionsFor,
} from "@bfa-platform/api/lib/wizard-input";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@bfa-platform/ui/components/dialog";
import { FormError } from "@bfa-platform/ui/components/field-message";
import { PageTitle } from "@bfa-platform/ui/components/page-title";
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useActiveWp } from "@/lib/use-active-wp";
import { trpc } from "@/utils/trpc";

import { CompletionDialog } from "./completion-dialog";
import { AssemblyInfoStep } from "./steps/assembly-info-step";
import { ClosingStep } from "./steps/closing-step";
import { IdentificationStep } from "./steps/identification-step";
import { ResultStep } from "./steps/result-step";
import { ReviewStep } from "./steps/review-step";
import { TestStep } from "./steps/test-step";
import { WizardNav } from "./wizard-nav";
import { WizardProgress } from "./wizard-progress";
import { stepCount, stepKind, stepLabels } from "./wizard-steps";
import type { BfaType, WizardValues } from "./wizard-types";
import { firstIncompleteStep, stepMissingKeys } from "./wizard-validation";
import { WizardValidationProvider } from "./wizard-validation-context";

export type WizardFormState = {
	id: string | undefined;
	bfaType: BfaType;
	bin: string;
	/** The BIN text that was last looked up — what `bfaAssetId` and the prefilled data belong to. */
	resolvedBin: string;
	bfaAssetId: string | null;
	submittedBinText: string | null;
	prefilledKeys: Set<string>;
	overriddenFields: Set<string>;
	customerName: string;
	customerEmail: string;
	wizardData: WizardValues;
	testDate: string;
	signatureMethod: "signed" | "owner_absent" | "";
	signatureData: string | null;
	photoPaths: string[];
};

/** Today's date in the business zone (Pacific/Honolulu), as `YYYY-MM-DD` — the day a test is most likely being run. */
function today(): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Pacific/Honolulu",
	}).format(new Date());
}

/** The parts of the form a draft save persists, as one comparable string — what "unsaved changes" means. */
function snapshotOf(form: WizardFormState): string {
	return JSON.stringify([
		form.bin,
		form.bfaType,
		form.bfaAssetId,
		form.submittedBinText,
		form.customerName,
		form.customerEmail,
		form.testDate,
		form.signatureMethod,
		form.signatureData,
		form.photoPaths,
		[...form.overriddenFields].sort(),
		Object.entries(form.wizardData).sort(([a], [b]) => a.localeCompare(b)),
	]);
}

function emptyForm(): WizardFormState {
	return {
		id: undefined,
		bfaType: "RP",
		bin: "",
		resolvedBin: "",
		bfaAssetId: null,
		submittedBinText: null,
		prefilledKeys: new Set(),
		overriddenFields: new Set(),
		customerName: "",
		customerEmail: "",
		wizardData: {},
		testDate: today(),
		signatureMethod: "",
		signatureData: null,
		photoPaths: [],
	};
}

/**
 * Forgets everything that came from a BIN's asset: the assembly details,
 * the customer, the answers copied from its last test, the link to the asset
 * and the record of what was overwritten. What the certifier typed in
 * themselves stays — it is theirs, whichever BIN it was entered under.
 */
function dropPrefilled(input: WizardFormState): WizardFormState {
	// The type came from the asset, so the answers given under it go with it.
	const form =
		input.bfaAssetId !== null && input.bfaType !== "RP"
			? clearAssemblyData(input, input.bfaType)
			: input;
	const wizardData = Object.fromEntries(
		Object.entries(form.wizardData).filter(
			([key]) => !form.prefilledKeys.has(key),
		),
	);

	return {
		...form,
		// The type came from the asset too; without it, back to the default the
		// certifier picks from on the first screen.
		bfaType: form.bfaAssetId !== null ? "RP" : form.bfaType,
		resolvedBin: "",
		bfaAssetId: null,
		submittedBinText: null,
		prefilledKeys: new Set(),
		overriddenFields: new Set(),
		wizardData,
		customerName: form.prefilledKeys.has("customerName")
			? ""
			: form.customerName,
		customerEmail: form.prefilledKeys.has("customerEmail")
			? ""
			: form.customerEmail,
	};
}

/**
 * Forgets what belonged to the assembly the type was chosen for: its details
 * (address, make, model, serial number, size, location) and everything entered
 * for the test itself — the readings, the valve answers, the Initial Test and
 * the isolation answer. Another type is another assembly, and its questions
 * differ, so none of that carries over. The customer, comments, sign-off,
 * photos and the date are about the visit, not the assembly, and stay.
 */
function clearAssemblyData(
	form: WizardFormState,
	fromType: BfaType,
): WizardFormState {
	const keys = new Set<string>([
		...Object.values(ASSEMBLY_FIELD_KEYS),
		ADP_KEY,
		LINE_PRESSURE_KEY,
		WATER_METER_START_KEY,
		WATER_METER_END_KEY,
		INITIAL_TEST_KEY,
		ISOLATES_PROPERTY_KEY,
		...wizardQuestionsFor(fromType).flatMap((entry) =>
			entry.valueKey ? [entry.key, entry.valueKey] : [entry.key],
		),
	]);
	const without = <T,>(set: Set<T | string>) =>
		new Set([...set].filter((key) => !keys.has(key as string)));

	return {
		...form,
		wizardData: Object.fromEntries(
			Object.entries(form.wizardData).filter(([key]) => !keys.has(key)),
		),
		prefilledKeys: without(form.prefilledKeys),
		overriddenFields: without(form.overriddenFields),
	};
}

/**
 * The certifier test wizard's shell (build-plan § 6.5 step 1): chrome, draft
 * persistence, step navigation, and the Submit/Save-to-Draft/completion
 * flow. Every step below it is a plain, mostly-presentational component
 * reading and writing this one form state.
 */
export function WizardShell({ draftId }: { draftId?: string }) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { active, setActiveWp, isLoading: isWpLoading } = useActiveWp();

	const [form, setForm] = useState<WizardFormState>(emptyForm);
	const [step, setStep] = useState(1);
	const topRef = useRef<HTMLDivElement>(null);
	const previousStep = useRef(step);
	const total = stepCount(form.bfaType);
	// Which of Save draft / Next started the save, so only that button spins.
	const [savingKind, setSavingKind] = useState<"save" | "next">("save");
	const [hydrated, setHydrated] = useState(!draftId);
	const [completion, setCompletion] = useState<"submitted" | "saved" | null>(
		null,
	);
	// Set while navigating away from the completion pop-up. `router.push` only
	// swaps the page once Drafts has loaded — seconds, the first time in dev —
	// so the pop-up closes at once and a placeholder stands in until then,
	// rather than the pop-up hanging open or the finished form reappearing.
	const [leaving, setLeaving] = useState(false);
	// What the last save (or the initial state) looked like, to tell whether
	// leaving would throw anything away.
	const [savedSnapshot, setSavedSnapshot] = useState(() =>
		snapshotOf(emptyForm()),
	);
	const [showErrors, setShowErrors] = useState(false);
	const [errorTick, setErrorTick] = useState(0);
	const [exitOpen, setExitOpen] = useState(false);

	const draftQuery = useQuery(
		trpc.certifier.getDraft.queryOptions(
			{ id: draftId ?? "", waterPurveyorId: active?.id ?? "" },
			{ enabled: Boolean(draftId && active) },
		),
	);

	// Resuming a draft hydrates the form once, from the row it names, and
	// switches the active WP to whichever purveyor the draft was created
	// against — the dashboard's "Resume" link should not require also
	// manually switching WPs first.
	// biome-ignore lint/correctness/useExhaustiveDependencies: hydrates once when the draft query resolves, not on every render
	useEffect(() => {
		if (!draftId || hydrated || !draftQuery.data) return;

		const draft = draftQuery.data;
		if (draft.waterPurveyorId !== active?.id)
			setActiveWp(draft.waterPurveyorId);

		// Customer and photos travel inside `wizard_data`; pull them back out into
		// their own fields so the form holds each thing once.
		const {
			[CUSTOMER_NAME_KEY]: customerName,
			[CUSTOMER_EMAIL_KEY]: customerEmail,
			...answers
		} = (draft.wizardData ?? {}) as WizardValues;
		const photoPaths = PHOTO_PATH_KEYS.map((key) => answers[key]).filter(
			(value): value is string => typeof value === "string" && value !== "",
		);
		for (const key of PHOTO_PATH_KEYS) delete answers[key];

		const resumed: WizardFormState = {
			...emptyForm(),
			id: draft.id,
			bfaType: draft.bfaType as BfaType,
			bin: draft.bin ?? draft.submittedBinText ?? "",
			resolvedBin: (draft.bin ?? draft.submittedBinText ?? "").trim(),
			bfaAssetId: draft.bfaAssetId,
			submittedBinText: draft.submittedBinText,
			// A resolved draft's assembly and customer values came from the asset;
			// treating them as prefilled keeps a later edit flagged as an overwrite.
			prefilledKeys: draft.bfaAssetId
				? new Set([
						...Object.values(ASSEMBLY_FIELD_KEYS),
						"customerName",
						"customerEmail",
					])
				: new Set(),
			overriddenFields: new Set(
				Array.isArray(draft.overriddenFields)
					? (draft.overriddenFields as string[])
					: [],
			),
			customerName: typeof customerName === "string" ? customerName : "",
			customerEmail: typeof customerEmail === "string" ? customerEmail : "",
			wizardData: answers,
			testDate: draft.testDate ?? today(),
			signatureMethod:
				(draft.signatureMethod as "signed" | "owner_absent" | null) ?? "",
			signatureData: draft.signatureData,
			photoPaths,
		};

		setForm(resumed);
		setSavedSnapshot(snapshotOf(resumed));
		setStep(draft.currentStep ?? 1);
		setHydrated(true);
	}, [draftQuery.data, draftId, hydrated]);

	// Moving between screens brings the new one into view from its top — the
	// scroll position belongs to the shell's scrolling column, not the window,
	// so it would otherwise stay wherever the previous screen was left.
	useEffect(() => {
		if (previousStep.current === step) return;

		previousStep.current = step;
		setShowErrors(false);
		topRef.current?.scrollIntoView({ block: "start" });
	}, [step]);

	// After a refused attempt to continue, bring the first marked field into view.
	useEffect(() => {
		if (errorTick === 0) return;

		topRef.current
			?.querySelector('[data-invalid="true"]')
			?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [errorTick]);

	const saveDraft = useMutation(
		trpc.certifierWizard.saveDraftStep.mutationOptions(),
	);
	const submitTest = useMutation(
		trpc.certifierWizard.submitTest.mutationOptions(),
	);
	const getDocumentUrl = useMutation(
		trpc.certifierWizard.getResultDocumentUrl.mutationOptions(),
	);

	function setField<Key extends keyof WizardFormState>(
		key: Key,
		value: WizardFormState[Key],
	) {
		setForm((current) => ({ ...current, [key]: value }));
	}

	/** Updates one `wizard_data` answer, flagging it as overridden if it was prefilled. */
	function setAnswer(key: string, value: WizardValues[string]) {
		setForm((current) => ({
			...current,
			wizardData: { ...current.wizardData, [key]: value },
			overriddenFields: current.prefilledKeys.has(key)
				? new Set(current.overriddenFields).add(key)
				: current.overriddenFields,
		}));
	}

	/** Customer name/email are top-level fields; typing over a prefilled one flags it as overwritten. */
	function handleCustomerChange(
		field: "customerName" | "customerEmail",
		value: string,
	) {
		setForm((current) => ({
			...current,
			[field]: value,
			overriddenFields: current.prefilledKeys.has(field)
				? new Set(current.overriddenFields).add(field)
				: current.overriddenFields,
		}));
	}

	/**
	 * Saves everything entered so far, validation-free. Customer and photos ride
	 * in `wizard_data` (a draft has no columns for them); a cleared photo is
	 * sent as an explicit null because the server merges rather than replaces.
	 */
	async function persistDraft(
		nextStep: number,
		options?: { silent?: boolean },
	) {
		if (!active) return;

		const snapshot = snapshotOf(form);
		const result = await saveDraft.mutateAsync({
			id: form.id,
			waterPurveyorId: active.id,
			bfaType: form.bfaType,
			currentStep: nextStep,
			wizardData: {
				...form.wizardData,
				[CUSTOMER_NAME_KEY]: form.customerName,
				[CUSTOMER_EMAIL_KEY]: form.customerEmail,
				...Object.fromEntries(
					PHOTO_PATH_KEYS.map((key, index) => [
						key,
						form.photoPaths[index] ?? null,
					]),
				),
			},
			submittedBinText: form.bfaAssetId ? null : form.bin.trim() || null,
			bfaAssetId: form.bfaAssetId,
			testDate: form.testDate,
			signatureMethod: form.signatureMethod || null,
			signatureData: form.signatureData,
			overriddenFields: Array.from(form.overriddenFields),
		});

		if (!form.id) setField("id", result.id);
		setSavedSnapshot(snapshot);
		if (!options?.silent) toast.success("Saved");

		return result.id;
	}

	async function handleSaveToDraft() {
		setSavingKind("save");
		try {
			await persistDraft(step);
			setCompletion("saved");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save this draft",
			);
		}
	}

	/** Marks what a screen still lacks and scrolls to it, instead of going quietly nowhere. */
	function refuse() {
		setShowErrors(true);
		setErrorTick((tick) => tick + 1);
	}

	async function handleNext() {
		setSavingKind("next");
		if (stepMissingKeys(step, form).length > 0) {
			refuse();
			return;
		}

		try {
			await persistDraft(Math.min(step + 1, total), {
				silent: true,
			});
			setStep((current) => Math.min(current + 1, total));
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save this step",
			);
		}
	}

	function handleBack() {
		// The review preview has no Back — the wizard is finished by then.
		setStep((current) =>
			current >= total ? current : Math.max(1, current - 1),
		);
	}

	async function handleSubmit() {
		if (!active || !form.id) return;

		// The review is reachable with something lacking if an earlier screen was
		// edited afterwards; go back to the first screen that needs it.
		const incomplete = firstIncompleteStep(form);
		if (incomplete !== null) {
			setStep(incomplete);
			refuse();
			return;
		}

		try {
			await submitTest.mutateAsync({
				id: form.id,
				waterPurveyorId: active.id,
				bfaType: form.bfaType,
				wizardData: form.wizardData,
				customerName: form.customerName,
				customerEmail: form.customerEmail,
				testDate: form.testDate,
				signatureMethod: form.signatureMethod as "signed" | "owner_absent",
				signatureData: form.signatureData,
				photoPaths: form.photoPaths,
			});
			await queryClient.invalidateQueries({
				queryKey: trpc.certifier.listDrafts.queryKey(),
			});
			setCompletion("submitted");
		} catch {
			// Reported inline below, beside the Submit button.
		}
	}

	function leaveToDrafts() {
		setCompletion(null);
		setLeaving(true);
		router.push("/certifier/drafts");
	}

	function handleDoAnother() {
		const fresh = emptyForm();
		setForm(fresh);
		setSavedSnapshot(snapshotOf(fresh));
		setStep(1);
		setCompletion(null);
		router.replace("/certifier/wizard");
	}

	/** Leaving with unsaved changes asks first; with nothing to lose it just goes. */
	function handleExit() {
		if (snapshotOf(form) === savedSnapshot) {
			router.push("/certifier/drafts");
			return;
		}

		setExitOpen(true);
	}

	async function handleSaveAndExit() {
		try {
			await persistDraft(step, { silent: true });
			router.push("/certifier/drafts");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not save this draft",
			);
		}
	}

	const missing = new Set(stepMissingKeys(step, form));
	const current = stepKind(step, form.bfaType);
	// Once the assembly type is known the heading names it — "RPDA Test Wizard".
	const title =
		current.kind === "identification" && !form.bfaAssetId
			? "New Test"
			: `${form.bfaType} Test Wizard`;
	const nav = {
		isFirst: step === 1,
		isLast: step >= total,
		nextLabel: step === total - 1 ? "Preview" : "Next",
		saving: saveDraft.isPending,
		savingKind,
		submitting: submitTest.isPending,
		onBack: handleBack,
		onSave: handleSaveToDraft,
		onNext: handleNext,
		onSubmit: handleSubmit,
	};

	if (leaving || isWpLoading || (draftId && draftQuery.isPending)) {
		return (
			<div className="flex flex-col gap-4" aria-busy="true">
				<Skeleton className="h-9 w-64 rounded-md" />
				<Skeleton className="h-2 w-full rounded-full" />
				<Skeleton className="h-72 w-full rounded-xl" />
			</div>
		);
	}

	if (!active) {
		return (
			<p className="text-[13px] text-muted-foreground">
				You are not authorized for any water purveyor yet.
			</p>
		);
	}

	return (
		<div
			ref={topRef}
			className="mx-auto flex w-full max-w-[700px] scroll-mt-0 flex-col gap-5"
		>
			<div className="flex items-center justify-between">
				<PageTitle className="text-[20px] min-[780px]:text-[26px]">
					{title}
				</PageTitle>
				<Button variant="ghost" size="sm" onClick={handleExit}>
					<ArrowLeft aria-hidden="true" />
					Exit
				</Button>
			</div>

			{/* Which assembly this is, from the assembly screen on. */}
			{current.kind !== "identification" ? (
				<p className="-mt-2 text-[13px] text-muted-foreground">
					<span className="font-semibold text-foreground">
						{form.bin.trim() ? `BIN ${form.bin.trim()}` : "No BIN"}
					</span>
					{form.wizardData[ASSEMBLY_FIELD_KEYS.serviceAddress]
						? ` · ${form.wizardData[ASSEMBLY_FIELD_KEYS.serviceAddress]}`
						: ""}
				</p>
			) : null}

			<div className="flex w-full flex-col gap-6">
				{/* Progress and the phone's Back / Save / Next travel together and stay
				    pinned while the screen scrolls. `-top-4` cancels the column's 16px
				    padding so the block sits flush under the header; `-mt-4 pt-5` gives
				    that back at rest, so nothing moves. From the desktop breakpoint it is
				    an ordinary, unpinned progress bar and the buttons live in the footer. */}
				<div className="sticky -top-4 z-20 -mx-4 -mt-4 flex flex-col gap-3 border-border border-b bg-background px-4 pt-5 pb-3 min-[780px]:static min-[780px]:m-0 min-[780px]:border-0 min-[780px]:bg-transparent min-[780px]:p-0">
					{/* The review is a preview of the finished form, not a step — no progress bar. */}
					{current.kind === "review" ? null : (
						<WizardProgress step={step} labels={stepLabels(form.bfaType)} />
					)}
					<WizardNav {...nav} className="flex min-[780px]:hidden" />
				</div>

				{/* One card holds the fields and the buttons. The step cards inside it
				    drop their own frame, so the card reads as a single form. The review
				    keeps its several cards and sits outside the frame. */}
				<div
					className={
						current.kind === "review"
							? "flex flex-col gap-6"
							: "flex flex-col gap-5 rounded-lg border border-border bg-card p-5 shadow-[var(--shadow-card)] [&_[data-slot=card-content]]:px-0 [&_[data-slot=card]]:gap-0 [&_[data-slot=card]]:border-0 [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:p-0 [&_[data-slot=card]]:py-0 [&_[data-slot=card]]:shadow-none"
					}
				>
					<WizardValidationProvider value={{ showErrors, missing }}>
						{current.kind === "identification" ? (
							<IdentificationStep
								form={form}
								waterPurveyorId={active.id}
								// Once the text no longer matches the BIN that was looked up, what came
								// from that BIN's asset is stale — it is dropped now, and a new lookup
								// fills it from the new one.
								onBinChange={(bin) =>
									setForm((current) =>
										current.bfaAssetId !== null &&
										bin.trim() !== current.resolvedBin
											? { ...dropPrefilled(current), bin }
											: { ...current, bin },
									)
								}
								onTypeChange={(bfaType) =>
									setForm((current) =>
										bfaType === current.bfaType
											? current
											: {
													...clearAssemblyData(current, current.bfaType),
													bfaType,
												},
									)
								}
								onResolved={({
									asset,
									priorWizardData,
									customer,
									prefilledKeys,
								}) => {
									setForm((current) => {
										const bin = current.bin.trim();

										// Looking up the same BIN again changes nothing — and must not
										// wipe what the certifier has since edited.
										if (
											bin === current.resolvedBin &&
											(asset?.id ?? null) === current.bfaAssetId
										) {
											return current;
										}

										// A different BIN (or none found): whatever the previous one filled
										// in goes, and this one's data takes its place.
										const nextType =
											(asset?.bfaType as BfaType) ?? current.bfaType;
										// Answers given under another type mean nothing under this one.
										const base = dropPrefilled(
											nextType === current.bfaType
												? current
												: clearAssemblyData(current, current.bfaType),
										);

										return {
											...base,
											resolvedBin: bin,
											bfaAssetId: asset?.id ?? null,
											submittedBinText: asset ? null : bin,
											bfaType: (asset?.bfaType as BfaType) ?? base.bfaType,
											wizardData: { ...base.wizardData, ...priorWizardData },
											customerName: customer?.name ?? base.customerName,
											customerEmail: customer?.email ?? base.customerEmail,
											prefilledKeys,
										};
									});
								}}
							/>
						) : null}

						{current.kind === "assembly" ? (
							<AssemblyInfoStep form={form} onAnswer={setAnswer} />
						) : null}

						{current.kind === "test" ? (
							<TestStep
								bfaType={form.bfaType}
								page={current.page}
								values={form.wizardData}
								overridden={form.overriddenFields}
								onAnswer={setAnswer}
							/>
						) : null}

						{current.kind === "result" ? (
							<ResultStep
								values={form.wizardData}
								overridden={form.overriddenFields}
								onAnswer={setAnswer}
							/>
						) : null}

						{current.kind === "closing" ? (
							<ClosingStep
								form={form}
								waterPurveyorId={active.id}
								onAnswer={setAnswer}
								onField={setField}
								onCustomer={handleCustomerChange}
							/>
						) : null}

						{current.kind === "review" ? (
							<ReviewStep
								form={form}
								wpName={active.name}
								waterPurveyorId={active.id}
							/>
						) : null}
					</WizardValidationProvider>

					<FormError
						message={submitTest.isError ? submitTest.error.message : null}
					/>

					{missing.size === 0 || current.kind === "review" ? null : (
						<p className="text-[12px] text-muted-foreground">
							Fields marked * are required. Fill them in to continue, or save
							what you have to Drafts.
						</p>
					)}

					<WizardNav
						{...nav}
						className="hidden border-border border-t pt-4 min-[780px]:flex"
					/>
				</div>
			</div>

			<CompletionDialog
				open={completion !== null}
				kind={completion}
				onDoAnother={handleDoAnother}
				onExit={leaveToDrafts}
				// A saved draft can be kept editing; a submitted test is done, so the
				// X takes the certifier out of the finished wizard.
				onDismiss={() =>
					completion === "submitted" ? leaveToDrafts() : setCompletion(null)
				}
				fetchPdfUrl={async () =>
					(
						await getDocumentUrl.mutateAsync({
							id: form.id ?? "",
							waterPurveyorId: active.id,
						})
					).url
				}
			/>

			<Dialog open={exitOpen} onOpenChange={setExitOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Leave without saving?</DialogTitle>
						<DialogDescription>
							You have changes that are not saved yet. Save them to Drafts to
							pick this test up later, or leave and lose them.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setExitOpen(false)}>
							Keep editing
						</Button>
						<Button
							variant="destructive"
							onClick={() => router.push("/certifier/drafts")}
						>
							Discard
						</Button>
						<Button disabled={saveDraft.isPending} onClick={handleSaveAndExit}>
							{saveDraft.isPending ? "Saving…" : "Save and exit"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
