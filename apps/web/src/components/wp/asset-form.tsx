"use client";

import { ASSET_FIELD_LIMITS } from "@bfa-platform/api/lib/asset-field-limits";
import { Button } from "@bfa-platform/ui/components/button";
import { DialogFooter } from "@bfa-platform/ui/components/dialog";
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
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import type { Asset, AssetPayload } from "./asset-types";
import { BFA_TYPE_LABELS } from "./asset-types";

/**
 * What the form holds while it is being typed into. Every field is a string,
 * including the type enum and the date, because that is what an input hands
 * back — the conversion to the procedure's shape happens once, in
 * `buildAssetPayload`.
 */
export type AssetFormValues = {
	bin: string;
	bfaType: AssetPayload["bfaType"];
	serviceAddress: string;
	assemblyLocation: string;
	make: string;
	model: string;
	serialNumber: string;
	size: string;
	annualTestDate: string;
};

export const emptyAssetValues: AssetFormValues = {
	bin: "",
	bfaType: "RP",
	serviceAddress: "",
	assemblyLocation: "",
	make: "",
	model: "",
	serialNumber: "",
	size: "",
	annualTestDate: "",
};

/** An existing row as form values. Nullable columns become empty strings. */
export function assetToFormValues(asset: Asset): AssetFormValues {
	return {
		bin: asset.bin,
		bfaType: asset.bfaType,
		serviceAddress: asset.serviceAddress,
		assemblyLocation: asset.assemblyLocation ?? "",
		make: asset.make ?? "",
		model: asset.model ?? "",
		serialNumber: asset.serialNumber ?? "",
		size: asset.size ?? "",
		annualTestDate: asset.annualTestDate ?? "",
	};
}

/**
 * Form values as the procedure's input. Blank optional fields become `null`, so
 * clearing one on the form is the same request as never having filled it in —
 * the server stores NULL either way rather than two spellings of empty.
 */
export function buildAssetPayload(values: AssetFormValues): AssetPayload {
	return {
		bin: values.bin.trim(),
		bfaType: values.bfaType,
		serviceAddress: values.serviceAddress.trim(),
		assemblyLocation: values.assemblyLocation.trim() || null,
		make: values.make.trim() || null,
		model: values.model.trim() || null,
		serialNumber: values.serialNumber.trim() || null,
		size: values.size.trim() || null,
		annualTestDate: values.annualTestDate,
	};
}

/**
 * Whether `value` is a real calendar day, not merely `NNNN-NN-NN`.
 *
 * A native date input will not usually hand back anything else, but the field
 * is a plain string in a form that can be filled programmatically, and
 * "2027-02-31" parsing into 3 March is the kind of wrong that only shows up
 * months later as a reminder that fired on the wrong day. Round-tripping
 * through `Date` is what catches it: the parsed day has to spell itself the
 * same way back.
 */
export function isCalendarDate(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

	const parsed = new Date(`${value}T00:00:00Z`);

	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

/**
 * Which required fields are not yet answered.
 *
 * The same three rules the server enforces, applied to the trimmed values so a
 * BIN of spaces reads as empty here exactly as it does in `createAssetInput`.
 * This is a convenience — it stops a request that would be refused — and never
 * the boundary: everything below is checked again in the procedure.
 */
export function assetFormProblems(values: AssetFormValues) {
	return {
		bin: values.bin.trim().length === 0,
		serviceAddress: values.serviceAddress.trim().length === 0,
		annualTestDate: !isCalendarDate(values.annualTestDate),
	};
}

export function isAssetFormValid(values: AssetFormValues) {
	return !Object.values(assetFormProblems(values)).some(Boolean);
}

/**
 * The asset field set. `AddAssetForm` and `EditAssetForm` below are this form
 * with their starting values and labels fixed — the fields themselves are one
 * component, because two copies would be two places for the BIN rules and the
 * annual test date to drift apart.
 *
 * Split out from its dialog so the submit behaviour can be exercised without
 * driving a modal's portal and focus trap, the same way `CustomerForm` is.
 *
 * Two columns the table shows are deliberately not here. `asset_status` is
 * computed by the scheduler from the annual test date, so there is nothing for
 * a person to choose; and the current customer is attached from the asset's own
 * page, where the change can be recorded as occupancy rather than as an edit.
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
	onSubmit: (payload: AssetPayload) => void;
	onCancel: () => void;
}) {
	const binId = useId();
	const binMessageId = useId();
	const bfaTypeId = useId();
	const serviceAddressId = useId();
	const assemblyLocationId = useId();
	const makeId = useId();
	const modelId = useId();
	const serialNumberId = useId();
	const sizeId = useId();
	const annualTestDateId = useId();
	const annualTestDateHintId = useId();

	const [values, setValues] = useState<AssetFormValues>(initialValues);
	// Which BIN the rejected request carried. The server's "already in use"
	// answer is about that exact value, so it stops applying the moment the
	// field is edited — leaving it on screen would make a BIN the person has
	// already fixed look like it is still refused.
	const [rejectedBin, setRejectedBin] = useState<string | null>(null);

	function update<Field extends keyof AssetFormValues>(
		field: Field,
		value: AssetFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!isAssetFormValid(values)) return;

		setRejectedBin(values.bin.trim());
		onSubmit(buildAssetPayload(values));
	}

	const problems = assetFormProblems(values);
	const binTaken =
		binErrorMessage && rejectedBin === values.bin.trim()
			? binErrorMessage
			: undefined;
	// The BIN is the key every notice, submission and wizard prefill hangs off,
	// and changing one is an audited act. The form says so at the moment it
	// changes rather than after the save, so the warning is a decision the person
	// can still take back.
	const binChanged =
		initialValues.bin !== "" && values.bin.trim() !== initialValues.bin;

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={binId}>BIN</Label>
					<Input
						id={binId}
						name="bin"
						value={values.bin}
						onChange={(event) => update("bin", event.target.value)}
						placeholder="BIN-10041"
						autoComplete="off"
						maxLength={ASSET_FIELD_LIMITS.bin}
						disabled={pending}
						required
						aria-invalid={binTaken ? true : undefined}
						aria-describedby={binTaken ? binMessageId : undefined}
					/>
					{binTaken ? (
						<p
							id={binMessageId}
							role="alert"
							className="flex items-start gap-1.5 text-[12px] text-danger"
						>
							<TriangleAlert
								className="mt-px size-3.5 shrink-0"
								aria-hidden="true"
							/>
							{binTaken}
						</p>
					) : null}
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={bfaTypeId}>BFA type</Label>
					<Select
						items={BFA_TYPE_LABELS}
						value={values.bfaType}
						onValueChange={(value) =>
							update("bfaType", value as AssetPayload["bfaType"])
						}
						disabled={pending}
					>
						<SelectTrigger id={bfaTypeId} name="bfaType">
							<SelectValue />
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
				</div>
			</div>

			{binChanged ? (
				<p
					role="status"
					className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					Changing a BIN is recorded: this save is logged with{" "}
					<strong className="font-semibold">{initialValues.bin}</strong> and the
					new value. Every test, notice and prefill for this assembly is keyed
					on it.
				</p>
			) : null}

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={serviceAddressId}>Service address</Label>
				<Input
					id={serviceAddressId}
					name="serviceAddress"
					value={values.serviceAddress}
					onChange={(event) => update("serviceAddress", event.target.value)}
					placeholder="18 Canal Road"
					autoComplete="off"
					maxLength={ASSET_FIELD_LIMITS.serviceAddress}
					disabled={pending}
					required
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={assemblyLocationId}>Assembly location</Label>
				<Input
					id={assemblyLocationId}
					name="assemblyLocation"
					value={values.assemblyLocation}
					onChange={(event) => update("assemblyLocation", event.target.value)}
					placeholder="Optional — where on the property the assembly sits"
					autoComplete="off"
					maxLength={ASSET_FIELD_LIMITS.assemblyLocation}
					disabled={pending}
				/>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={makeId}>Make</Label>
					<Input
						id={makeId}
						name="make"
						value={values.make}
						onChange={(event) => update("make", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						maxLength={ASSET_FIELD_LIMITS.make}
						disabled={pending}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={modelId}>Model</Label>
					<Input
						id={modelId}
						name="model"
						value={values.model}
						onChange={(event) => update("model", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						maxLength={ASSET_FIELD_LIMITS.model}
						disabled={pending}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={serialNumberId}>Serial number</Label>
					<Input
						id={serialNumberId}
						name="serialNumber"
						value={values.serialNumber}
						onChange={(event) => update("serialNumber", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						maxLength={ASSET_FIELD_LIMITS.serialNumber}
						disabled={pending}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={sizeId}>Size</Label>
					<Input
						id={sizeId}
						name="size"
						value={values.size}
						onChange={(event) => update("size", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						maxLength={ASSET_FIELD_LIMITS.size}
						disabled={pending}
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={annualTestDateId}>Annual test date</Label>
				<Input
					id={annualTestDateId}
					name="annualTestDate"
					type="date"
					value={values.annualTestDate}
					onChange={(event) => update("annualTestDate", event.target.value)}
					disabled={pending}
					required
					aria-describedby={annualTestDateHintId}
				/>
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

			{errorMessage ? (
				<p
					role="alert"
					className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{errorMessage}
				</p>
			) : null}

			<DialogFooter>
				<Button
					type="button"
					variant="secondary"
					onClick={onCancel}
					disabled={pending}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={pending || !isAssetFormValid(values)}
					// Says which answer is still missing, rather than leaving a dead
					// button to be interpreted.
					title={
						problems.bin
							? "A BIN is required"
							: problems.serviceAddress
								? "A service address is required"
								: problems.annualTestDate
									? "A valid annual test date is required"
									: undefined
					}
				>
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
	onSubmit: (payload: AssetPayload) => void;
	onCancel: () => void;
};

/** Registering a valve the WP owns, with no certifier submission behind it. */
export function AddAssetForm(props: BoundFormProps) {
	return (
		<AssetForm {...props} submitLabel="Add asset" pendingLabel="Adding…" />
	);
}

/** Correcting an existing record, the BIN included. */
export function EditAssetForm({
	asset,
	...props
}: BoundFormProps & { asset: Asset }) {
	return (
		<AssetForm
			{...props}
			initialValues={assetToFormValues(asset)}
			submitLabel="Save changes"
			pendingLabel="Saving…"
		/>
	);
}
