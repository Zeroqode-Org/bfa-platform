"use client";

import { ASSEMBLY_FIELD_KEYS } from "@bfa-platform/api/lib/wizard-input";
import { Button } from "@bfa-platform/ui/components/button";
import { Card, CardContent } from "@bfa-platform/ui/components/card";
import { Input } from "@bfa-platform/ui/components/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bfa-platform/ui/components/select";
import { PenLine } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { WizardField } from "../wizard-field";
import type { WizardFormState } from "../wizard-shell";
import {
	BFA_TYPE_CODES,
	BFA_TYPE_OPTIONS,
	type BfaType,
	type WizardValues,
} from "../wizard-types";

const FIELDS: { key: keyof typeof ASSEMBLY_FIELD_KEYS; label: string }[] = [
	{ key: "serviceAddress", label: "Service address" },
	{ key: "make", label: "Make" },
	{ key: "model", label: "Model" },
	{ key: "serialNumber", label: "Serial number" },
	{ key: "size", label: "Size" },
	{ key: "location", label: "Assembly location" },
];

/**
 * Step 2 — assembly details (build-plan § 6.5 step 10). Read-only tint
 * styling for a prefilled field, a normal input when certifier-entered —
 * same layout either way, never two different screens. Every prefilled
 * field stays editable; typing over one flags it as overridden.
 *
 * A found assembly's BFA type is editable here too (client, October 2026),
 * opening on the type the register holds. Changing it resets the test answers
 * and flags the type as overwritten — see `changeFoundAssetType`. A BIN that
 * was not found already chose its type on the first screen.
 */
export function AssemblyInfoStep({
	form,
	onAnswer,
	onTypeChange,
}: {
	form: WizardFormState;
	onAnswer: (key: string, value: WizardValues[string]) => void;
	onTypeChange: (bfaType: BfaType) => void;
}) {
	const isPrefilled = form.bfaAssetId !== null;

	return (
		<Card>
			<CardContent className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
				{isPrefilled ? (
					<BfaTypeField
						value={form.bfaType}
						overridden={form.overriddenFields.has("bfaType")}
						onChange={onTypeChange}
					/>
				) : null}
				{FIELDS.map(({ key, label }) => (
					<AssemblyField
						key={key}
						label={label}
						fieldKey={ASSEMBLY_FIELD_KEYS[key]}
						value={form.wizardData[ASSEMBLY_FIELD_KEYS[key]]}
						prefilled={isPrefilled}
						overridden={form.overriddenFields.has(ASSEMBLY_FIELD_KEYS[key])}
						numeric={key === "size"}
						onAnswer={onAnswer}
					/>
				))}
			</CardContent>
		</Card>
	);
}

/**
 * The found assembly's BFA type, full width above the details. Locked like
 * every other prefilled field — the same grey read-only input with a pencil —
 * and the pencil turns it into the type dropdown in place.
 */
function BfaTypeField({
	value,
	overridden,
	onChange,
}: {
	value: BfaType;
	overridden: boolean;
	onChange: (bfaType: BfaType) => void;
}) {
	const id = useId();
	// Stays a dropdown once unlocked, as `AssemblyField` stays an input.
	const [editing, setEditing] = useState(false);
	const locked = !overridden && !editing;

	return (
		<WizardField
			id={id}
			label="BFA type"
			required
			flagged={overridden}
			className="sm:col-span-2"
		>
			{(fid) =>
				locked ? (
					<div className="relative">
						<div className="absolute inset-y-0 right-1 z-10 flex items-center">
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="Edit BFA type"
								className="text-muted-foreground"
								onClick={() => setEditing(true)}
							>
								<PenLine aria-hidden="true" />
							</Button>
						</div>
						<Input id={fid} readOnly className="pr-9" value={value} />
					</div>
				) : (
					<Select
						items={BFA_TYPE_CODES}
						value={value}
						defaultOpen={editing && !overridden}
						onValueChange={(next) => onChange(next as BfaType)}
					>
						<SelectTrigger id={fid}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{Object.entries(BFA_TYPE_OPTIONS).map(([option, label]) => (
									<SelectItem key={option} value={option}>
										{label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				)
			}
		</WizardField>
	);
}

/** Digits and at most one decimal point — anything else typed or pasted is dropped. */
function numericOnly(text: string): string {
	const [whole = "", ...rest] = text.replace(/[^0-9.]/g, "").split(".");

	return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

function AssemblyField({
	label,
	fieldKey,
	value,
	prefilled,
	overridden,
	numeric,
	onAnswer,
}: {
	label: string;
	fieldKey: string;
	value: WizardValues[string];
	prefilled: boolean;
	overridden: boolean;
	/** A numeric field takes digits and a decimal point only. */
	numeric?: boolean;
	onAnswer: (key: string, value: WizardValues[string]) => void;
}) {
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	// Once the certifier asks to edit a prefilled field, it stays an input for
	// the rest of the session — `overridden` alone would flip it back to
	// read-only if they cleared it back to the original value mid-edit.
	const [editing, setEditing] = useState(false);
	const locked = prefilled && !overridden && !editing;

	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	// A prefilled field renders as a flat read-only input with a pencil inside
	// it, on the right; pressing the pencil unlocks the same input in place —
	// same layout either way, never a second screen.
	return (
		<WizardField
			id={id}
			label={label}
			required
			fieldKey={fieldKey}
			flagged={prefilled && overridden}
		>
			{(fid) => (
				<div className="relative">
					{locked ? (
						// Centred by a flex wrapper, not `-translate-y-1/2`: the button's own
						// `active:translate-y-px` would override that transform while it is
						// pressed and make the icon jump.
						<div className="absolute inset-y-0 right-1 z-10 flex items-center">
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={`Edit ${label}`}
								className="text-muted-foreground"
								onClick={() => setEditing(true)}
							>
								<PenLine aria-hidden="true" />
							</Button>
						</div>
					) : null}
					<Input
						id={fid}
						ref={inputRef}
						readOnly={locked}
						inputMode={numeric ? "decimal" : undefined}
						className={locked ? "pr-9" : undefined}
						value={locked && !value ? "—" : ((value as string) ?? "")}
						onChange={(event) =>
							onAnswer(
								fieldKey,
								numeric ? numericOnly(event.target.value) : event.target.value,
							)
						}
					/>
				</div>
			)}
		</WizardField>
	);
}
