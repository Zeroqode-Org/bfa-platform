"use client";

import {
	ASSEMBLY_FIELD_KEYS,
	parseSize,
} from "@bfa-platform/api/lib/wizard-input";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { trpc } from "@/utils/trpc";

import { WizardField } from "../wizard-field";
import type { WizardFormState } from "../wizard-shell";
import {
	BFA_TYPE_OPTIONS,
	type BfaType,
	type WizardValues,
} from "../wizard-types";

/** Each type's bare code, for the closed select trigger. */
const BFA_TYPE_CODES = Object.fromEntries(
	Object.keys(BFA_TYPE_OPTIONS).map((code) => [code, code]),
);

/** Long enough that typing a BIN is one request, short enough to feel live. */
const SUGGEST_DEBOUNCE_MS = 250;

export type BinResolution = {
	asset: {
		id: string;
		bin: string;
		bfaType: BfaType;
		make: string | null;
		model: string | null;
		serialNumber: string | null;
		size: string | null;
		serviceAddress: string;
		assemblyLocation: string | null;
	} | null;
	priorWizardData: WizardValues;
	customer: { name: string; email: string } | null;
	prefilledKeys: Set<string>;
};

/**
 * Step 1 — types a BIN. Build-plan § 6.5 steps 6–9: found prefills assembly
 * and customer info from the database (still editable); blank or not found
 * unlocks every downstream field for manual entry.
 *
 * While typing, the active WP's matching BINs are suggested in a dropdown;
 * picking one looks it up straight away. Nothing forces a pick — a BIN that
 * matches no suggestion is simply typed and takes the no-BIN path.
 */
export function IdentificationStep({
	form,
	waterPurveyorId,
	onBinChange,
	onTypeChange,
	onResolved,
}: {
	form: WizardFormState;
	waterPurveyorId: string;
	onBinChange: (bin: string) => void;
	onTypeChange: (bfaType: BfaType) => void;
	onResolved: (resolution: BinResolution) => void;
}) {
	const binId = useId();
	const typeId = useId();
	const queryClient = useQueryClient();
	const [looking, setLooking] = useState(false);
	// What the lookup found is read off the form, not remembered here: the form
	// drops it the moment the BIN text stops matching what was looked up.
	const status = looking
		? "looking"
		: form.bfaAssetId
			? "found"
			: form.resolvedBin !== "" && form.resolvedBin === form.bin.trim()
				? "not_found"
				: "idle";
	const [open, setOpen] = useState(false);
	const [appliedQuery, setAppliedQuery] = useState("");

	useEffect(() => {
		const timer = setTimeout(
			() => setAppliedQuery(form.bin.trim()),
			SUGGEST_DEBOUNCE_MS,
		);

		return () => clearTimeout(timer);
	}, [form.bin]);

	const suggestions = useQuery({
		...trpc.certifierWizard.searchBins.queryOptions({
			waterPurveyorId,
			query: appliedQuery,
		}),
		enabled: appliedQuery.length > 0,
	});
	const options = appliedQuery ? (suggestions.data ?? []) : [];
	// An exact match needs no dropdown — it would only repeat what is typed.
	const visibleOptions = options.filter((option) => option.bin !== form.bin);
	const showList = open && visibleOptions.length > 0;

	async function handleLookup(binOverride?: string) {
		const bin = (binOverride ?? form.bin).trim();
		setOpen(false);

		if (!bin) {
			onResolved({
				asset: null,
				priorWizardData: {},
				customer: null,
				prefilledKeys: new Set(),
			});
			setLooking(false);
			return;
		}

		setLooking(true);

		const result = await queryClient.fetchQuery(
			trpc.certifierWizard.lookupAssetByBin.queryOptions({
				waterPurveyorId,
				bin,
			}),
		);

		if (!result.found) {
			onResolved({
				asset: null,
				priorWizardData: {},
				customer: null,
				prefilledKeys: new Set(),
			});
			setLooking(false);
			return;
		}

		const prefilledKeys = new Set<string>([
			ASSEMBLY_FIELD_KEYS.serviceAddress,
			ASSEMBLY_FIELD_KEYS.make,
			ASSEMBLY_FIELD_KEYS.model,
			ASSEMBLY_FIELD_KEYS.serialNumber,
			ASSEMBLY_FIELD_KEYS.size,
			ASSEMBLY_FIELD_KEYS.location,
			...Object.keys(result.priorWizardData ?? {}),
		]);
		if (result.customer) prefilledKeys.add("customerName").add("customerEmail");

		onResolved({
			asset: result.asset,
			priorWizardData: {
				...result.priorWizardData,
				[ASSEMBLY_FIELD_KEYS.serviceAddress]: result.asset.serviceAddress,
				[ASSEMBLY_FIELD_KEYS.make]: result.asset.make,
				[ASSEMBLY_FIELD_KEYS.model]: result.asset.model,
				[ASSEMBLY_FIELD_KEYS.serialNumber]: result.asset.serialNumber,
				[ASSEMBLY_FIELD_KEYS.size]: parseSize(result.asset.size),
				[ASSEMBLY_FIELD_KEYS.location]: result.asset.assemblyLocation,
			},
			customer: result.customer,
			prefilledKeys,
		});
		setLooking(false);
	}

	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<WizardField id={binId} label="BIN" fieldKey="bin">
					{(id) => (
						<div className="flex gap-2">
							<div className="relative flex-1">
								<Input
									id={id}
									autoComplete="off"
									value={form.bin}
									onChange={(event) => {
										onBinChange(event.target.value);
										setOpen(true);
									}}
									onFocus={() => setOpen(true)}
									onBlur={() => setOpen(false)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											handleLookup();
										}
										if (event.key === "Escape") setOpen(false);
									}}
									placeholder="Enter BIN"
								/>
								{open &&
								suggestions.isFetching &&
								visibleOptions.length === 0 ? (
									<div className="absolute top-full right-0 left-0 z-20 mt-1 rounded-md border border-border bg-card px-2.5 py-2 text-[12px] text-muted-foreground shadow-[var(--shadow-card)]">
										Searching…
									</div>
								) : null}
								{showList ? (
									<ul className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-[var(--shadow-card)]">
										{visibleOptions.map((option) => (
											<li key={option.id}>
												{/* onMouseDown, not onClick: the input's blur would
												    close the list before a click could land. */}
												<button
													type="button"
													className="flex w-full flex-col items-start rounded-sm px-2.5 py-1.5 text-left hover:bg-muted focus-visible:bg-muted"
													onMouseDown={(event) => {
														event.preventDefault();
														onBinChange(option.bin);
														handleLookup(option.bin);
													}}
												>
													<span className="font-semibold text-[13px]">
														{option.bin}
													</span>
													<span className="text-[12px] text-muted-foreground">
														{option.bfaType} · {option.serviceAddress}
													</span>
												</button>
											</li>
										))}
									</ul>
								) : null}
							</div>
							<Button
								type="button"
								variant="secondary"
								disabled={status === "looking"}
								onClick={() => handleLookup()}
							>
								{status === "looking" ? (
									<LoaderCircle className="animate-spin" aria-hidden="true" />
								) : (
									<Search aria-hidden="true" />
								)}
								{status === "looking" ? "Looking up…" : "Look up"}
							</Button>
						</div>
					)}
				</WizardField>

				{status === "found" ? (
					<p className="text-[13px] text-success">
						BIN found — assembly and customer info below are prefilled and can
						still be edited.
					</p>
				) : status === "not_found" ? (
					<p className="text-[13px] text-warning">
						No BIN found. Choose the assembly type below and fill in the rest
						manually.
					</p>
				) : null}

				{status !== "found" ? (
					<WizardField id={typeId} required label="Assembly type">
						{(id) => (
							<Select
								// The closed field shows just the code ("RPDA-2"), which fits one
								// line; the open list below spells each type out.
								items={BFA_TYPE_CODES}
								value={form.bfaType}
								onValueChange={(value) => onTypeChange(value as BfaType)}
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
					</WizardField>
				) : null}
			</CardContent>
		</Card>
	);
}
