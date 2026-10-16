"use client";

import { ASSET_FIELD_LIMITS } from "@bfa-platform/api/lib/asset-field-limits";
import { Button } from "@bfa-platform/ui/components/button";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import { DialogBody, DialogFooter } from "@bfa-platform/ui/components/dialog";
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
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	isoToUsDate,
	maxLength,
	required,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import type { Asset, AssetPayload } from "./asset-types";
import { BFA_TYPE_LABELS } from "./asset-types";

/**
 * What the form holds while it is being typed into. Every field is a string,
 * including the type enum and the date, because that is what an input hands
 * back — the conversion to the procedure's shape happens once, in
 * `buildAssetPayload`.
 *
 * `annualTestDate` is the date as displayed, `MM/DD/YYYY`; the API's
 * `YYYY-MM-DD` exists only on the way in and out.
 *
 * `bfaType` may be `""` — the type before anything is chosen. The add form
 * does not open that way any more (see `newAssetValues`), but the guard stays:
 * `""` is never sent to the procedure's enum.
 */
export type AssetFormValues = {
	bin: string;
	bfaType: AssetPayload["bfaType"] | "";
	serviceAddress: string;
	assemblyLocation: string;
	make: string;
	model: string;
	serialNumber: string;
	size: string;
	annualTestDate: string;
};

/** Form values in which the BFA type holds a real choice — the only kind that is sent. */
export type CompletedAssetFormValues = AssetFormValues & {
	bfaType: AssetPayload["bfaType"];
};

/** Whether the BFA type has been answered, so the values may become a payload. */
export function isCompletedAsset(
	values: AssetFormValues,
): values is CompletedAssetFormValues {
	return values.bfaType !== "";
}

export const emptyAssetValues: AssetFormValues = {
	bin: "",
	bfaType: "",
	serviceAddress: "",
	assemblyLocation: "",
	make: "",
	model: "",
	serialNumber: "",
	size: "",
	annualTestDate: "",
};

/**
 * Where most assemblies sit, as the purveyor phrases it (WP/Admin feedback).
 * Prefilled on a new asset and editable like any typed value.
 */
export const DEFAULT_ASSEMBLY_LOCATION =
	"After meter prior to any tees or branches";

/**
 * What **Add asset** opens with. The client asked for the commonest answers to
 * be there already — RP is the usual type, and the location above the usual
 * placement — so registering a typical assembly is fewer keystrokes. Both stay
 * ordinary editable values: nothing marks them as defaults once saved.
 */
export const newAssetValues: AssetFormValues = {
	...emptyAssetValues,
	bfaType: "RP",
	assemblyLocation: DEFAULT_ASSEMBLY_LOCATION,
};

/** An existing row as form values. Nullable columns become empty strings. */
export function assetToFormValues(asset: Asset): CompletedAssetFormValues {
	return {
		bin: asset.bin,
		bfaType: asset.bfaType,
		serviceAddress: asset.serviceAddress,
		assemblyLocation: asset.assemblyLocation ?? "",
		make: asset.make ?? "",
		model: asset.model ?? "",
		serialNumber: asset.serialNumber ?? "",
		size: asset.size ?? "",
		annualTestDate: isoToUsDate(asset.annualTestDate),
	};
}

/**
 * Form values as the procedure's input, every text field trimmed.
 *
 * The annual test date goes out as the API's `YYYY-MM-DD`. One that is not a
 * real day is sent as typed rather than blanked: the form does not submit it,
 * and if something else does, the server's refusal is the honest answer.
 *
 * Takes only completed values: an unanswered BFA type is never converted into a
 * default here, and `""` never reaches the procedure's enum.
 */
export function buildAssetPayload(
	values: CompletedAssetFormValues,
): AssetPayload {
	return {
		bin: values.bin.trim(),
		bfaType: values.bfaType,
		serviceAddress: values.serviceAddress.trim(),
		assemblyLocation: values.assemblyLocation.trim(),
		make: values.make.trim(),
		model: values.model.trim(),
		serialNumber: values.serialNumber.trim(),
		size: values.size.trim(),
		annualTestDate: usDateToIso(values.annualTestDate) ?? values.annualTestDate,
	};
}

/**
 * The server's rules for the asset fields, checked on the trimmed values so a
 * BIN of spaces reads as empty here exactly as it does in `createAssetInput`.
 * This is a convenience — it stops a request that would be refused and says
 * why at the field — and never the boundary: all of it is checked again in the
 * procedure. `serialNumber` stays free text; only its length is checked.
 */
export const assetFormRules = {
	bin: composeRules(
		required("A BIN is required."),
		maxLength(ASSET_FIELD_LIMITS.bin),
	),
	bfaType: required("Select a BFA type."),
	serviceAddress: composeRules(
		required("A service address is required."),
		maxLength(ASSET_FIELD_LIMITS.serviceAddress),
	),
	assemblyLocation: composeRules(
		required("An assembly location is required."),
		maxLength(ASSET_FIELD_LIMITS.assemblyLocation),
	),
	make: composeRules(
		required("A make is required."),
		maxLength(ASSET_FIELD_LIMITS.make),
	),
	model: composeRules(
		required("A model is required."),
		maxLength(ASSET_FIELD_LIMITS.model),
	),
	serialNumber: composeRules(
		required("A serial number is required."),
		maxLength(ASSET_FIELD_LIMITS.serialNumber),
	),
	size: composeRules(
		required("A size is required."),
		maxLength(ASSET_FIELD_LIMITS.size),
	),
	annualTestDate: composeRules(
		required("An annual test date is required."),
		usDate(),
	),
};

/**
 * The asset field set. `AddAssetForm` and `EditAssetForm` below are this form
 * with their starting values and labels fixed — the fields themselves are one
 * component, because two copies would be two places for the BIN rules and the
 * annual test date to drift apart.
 *
 * Split out from its dialog so the submit behaviour can be exercised without
 * driving a modal's portal and focus trap, the same way `CustomerForm` is.
 *
 * `asset_status` is deliberately absent: the scheduler computes it from the
 * annual test date, so there is nothing for a person to choose.
 *
 * There is no customer control, on either form. A customer reaches an asset
 * from the customer form, by BIN, or from the asset's own page — both close
 * and open occupancy rows as they go (WP/Admin feedback removed the picker
 * that used to sit on the add form).
 */
export function AssetForm({
	initialValues = emptyAssetValues,
	pending = false,
	errorMessage,
	binErrorMessage,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
}: {
	initialValues?: AssetFormValues;
	pending?: boolean;
	/** A server refusal with no field of its own. */
	errorMessage?: string;
	/** A server refusal about the BIN — shown under that input, not above the form. */
	binErrorMessage?: string;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (values: CompletedAssetFormValues) => void;
	onCancel: () => void;
}) {
	const annualTestDateHintId = useId();

	const [values, setValues] = useState<AssetFormValues>(initialValues);
	// Which BIN the rejected request carried. The server's "already in use"
	// answer is about that exact value, so it stops applying the moment the
	// field is edited — leaving it on screen would make a BIN the person has
	// already fixed look like it is still refused.
	const [rejectedBin, setRejectedBin] = useState<string | null>(null);

	const binTaken =
		binErrorMessage && rejectedBin === values.bin.trim()
			? binErrorMessage
			: undefined;

	const validation = useFormValidation({
		values,
		rules: assetFormRules,
		externalErrors: { bin: binTaken },
	});

	function update<Field extends keyof AssetFormValues>(
		field: Field,
		value: AssetFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!validation.validate() || !isCompletedAsset(values)) return;

		setRejectedBin(values.bin.trim());
		onSubmit(values);
	}

	// The BIN is the key every notice, submission and wizard prefill hangs off,
	// and changing one is an audited act. The form says so at the moment it
	// changes rather than after the save, so the warning is a decision the person
	// can still take back.
	const binChanged =
		initialValues.bin !== "" && values.bin.trim() !== initialValues.bin;

	/** One required free-text field, with its limit reported inline. */
	function requiredTextField(
		field: "make" | "model" | "serialNumber" | "size",
		label: string,
		placeholder: string,
	) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId(field)}>{label}</Label>
				<Input
					{...validation.controlProps(field)}
					name={field}
					value={values[field]}
					onChange={(event) => update(field, event.target.value)}
					placeholder={placeholder}
					autoComplete="off"
					disabled={pending}
					aria-required="true"
				/>
				<FieldError {...validation.errorProps(field)} />
			</div>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			// A column that takes exactly the height its dialog hands it. Only
			// `DialogBody` scrolls, so the footer stays on screen on a short
			// viewport instead of being pushed off the bottom of it.
			className="flex min-h-0 flex-1 flex-col gap-4"
			noValidate
		>
			<DialogBody>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("bin")}>BIN</Label>
						<Input
							{...validation.controlProps("bin")}
							name="bin"
							value={values.bin}
							onChange={(event) => update("bin", event.target.value)}
							placeholder="BIN-10041"
							autoComplete="off"
							disabled={pending}
						/>
						<FieldError {...validation.errorProps("bin")} />
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("bfaType")}>BFA type</Label>
						<Select
							items={BFA_TYPE_LABELS}
							value={values.bfaType || null}
							onValueChange={(value) =>
								update("bfaType", (value ?? "") as AssetFormValues["bfaType"])
							}
							disabled={pending}
						>
							<SelectTrigger
								{...validation.controlProps("bfaType")}
								name="bfaType"
							>
								<SelectValue placeholder={SELECT_PLACEHOLDER} />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{Object.entries(BFA_TYPE_LABELS).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						<FieldError {...validation.errorProps("bfaType")} />
					</div>
				</div>

				{binChanged ? (
					<p
						role="status"
						className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning"
					>
						<TriangleAlert
							className="mt-px size-4 shrink-0"
							aria-hidden="true"
						/>
						{/* One flex item for the whole message. Bare text either side of
						    the <strong> would each become their own flex item and lay out
						    as columns. `overflow-wrap:anywhere` lets a long BIN with no
						    spaces wrap instead of pushing out of the box. */}
						<span className="min-w-0 [overflow-wrap:anywhere]">
							Changing a BIN is recorded: this save is logged with{" "}
							<strong className="font-semibold">{initialValues.bin}</strong> and
							the new value. Every test, notice and prefill for this assembly is
							keyed on it.
						</span>
					</p>
				) : null}

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("serviceAddress")}>
						Service address
					</Label>
					<Input
						{...validation.controlProps("serviceAddress")}
						name="serviceAddress"
						value={values.serviceAddress}
						onChange={(event) => update("serviceAddress", event.target.value)}
						placeholder="18 Canal Road"
						autoComplete="off"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("serviceAddress")} />
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("assemblyLocation")}>
						Assembly location
					</Label>
					<Input
						{...validation.controlProps("assemblyLocation")}
						name="assemblyLocation"
						value={values.assemblyLocation}
						onChange={(event) => update("assemblyLocation", event.target.value)}
						placeholder="Where on the property the assembly sits"
						autoComplete="off"
						disabled={pending}
						aria-required="true"
					/>
					<FieldError {...validation.errorProps("assemblyLocation")} />
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					{requiredTextField("make", "Make", "Watts")}
					{requiredTextField("model", "Model", "LF909")}
					{requiredTextField("serialNumber", "Serial number", "AB12345")}
					{requiredTextField("size", "Size", '3/4"')}
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("annualTestDate")}>
						Annual test date
					</Label>
					<DateInput
						pickerLabel="Choose annual test date"
						{...validation.controlProps("annualTestDate", {
							describedBy: annualTestDateHintId,
						})}
						name="annualTestDate"
						value={values.annualTestDate}
						onValueChange={(value) => update("annualTestDate", value)}
						disabled={pending}
						aria-required="true"
					/>
					<FieldError {...validation.errorProps("annualTestDate")} />
					{/* The date is not a note on the record — it is what the reminder
					    schedule is built from, so the form says so where it is entered. */}
					<p
						id={annualTestDateHintId}
						className="text-[12px] text-muted-foreground"
					>
						Required. The reminder goes out about two months before this date,
						with the late notices following from it.
					</p>
				</div>

				<FormError message={errorMessage} />
			</DialogBody>
			<DialogFooter>
				<Button
					type="button"
					variant="secondary"
					onClick={onCancel}
					disabled={pending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={pending}>
					{pending ? pendingLabel : submitLabel}
				</Button>
			</DialogFooter>
		</form>
	);
}

type BoundFormProps = {
	pending?: boolean;
	errorMessage?: string;
	binErrorMessage?: string;
	onCancel: () => void;
};

/** Registering a valve the WP owns, with no certifier submission behind it. */
export function AddAssetForm({
	onSubmit,
	...props
}: BoundFormProps & {
	onSubmit: (payload: AssetPayload) => void;
}) {
	return (
		<AssetForm
			{...props}
			initialValues={newAssetValues}
			submitLabel="Add asset"
			pendingLabel="Adding…"
			onSubmit={(values) => onSubmit(buildAssetPayload(values))}
		/>
	);
}

/** Correcting an existing record, the BIN included. */
export function EditAssetForm({
	asset,
	onSubmit,
	...props
}: BoundFormProps & {
	asset: Asset;
	onSubmit: (payload: AssetPayload) => void;
}) {
	return (
		<AssetForm
			{...props}
			initialValues={assetToFormValues(asset)}
			submitLabel="Save changes"
			pendingLabel="Saving…"
			onSubmit={(values) => onSubmit(buildAssetPayload(values))}
		/>
	);
}
