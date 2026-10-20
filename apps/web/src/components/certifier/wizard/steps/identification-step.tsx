"use client";

import {
	ASSEMBLY_FIELD_KEYS,
	parseSize,
} from "@bfa-platform/api/lib/wizard-input";
import { Card, CardContent } from "@bfa-platform/ui/components/card";
import { Input } from "@bfa-platform/ui/components/input";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { trpc } from "@/utils/trpc";

import { WizardField } from "../wizard-field";
import type { WizardFormState } from "../wizard-shell";
import type { BfaType, WizardValues } from "../wizard-types";

/** Long enough that typing a BIN is one request, short enough to feel live. */
const SUGGEST_DEBOUNCE_MS = 250;

/** What a BIN found in the register prefills. */
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
	};
	priorWizardData: WizardValues;
	customer: { name: string; email: string } | null;
	prefilledKeys: Set<string>;
};

/**
 * Looks a BIN up in the active WP's register and returns what the wizard
 * should prefill from it, or null when it is not there. Build-plan § 6.5
 * steps 6–8; called by the wizard's Next on the first screen.
 */
export async function lookupBin(
	queryClient: QueryClient,
	waterPurveyorId: string,
	bin: string,
): Promise<BinResolution | null> {
	const result = await queryClient.fetchQuery(
		trpc.certifierWizard.lookupAssetByBin.queryOptions({
			waterPurveyorId,
			bin,
		}),
	);

	if (!result.found) return null;

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

	return {
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
	};
}

/**
 * Step 1 — one BIN field and Next (client, October 2026). Next looks the BIN
 * up: found prefills the assembly and customer (still editable); blank or not
 * found clears the field and goes on with no BIN, every downstream field
 * entered by hand. The assembly type is chosen on the next screen.
 *
 * While typing, the active WP's matching BINs are suggested in a dropdown;
 * picking one fills the field, and Next looks it up like a typed one.
 */
export function IdentificationStep({
	form,
	waterPurveyorId,
	onBinChange,
	onSubmit,
}: {
	form: WizardFormState;
	waterPurveyorId: string;
	onBinChange: (bin: string) => void;
	/** Enter in the field does what Next does. */
	onSubmit: () => void;
}) {
	const binId = useId();
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

	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<p className="text-[13px] text-muted-foreground">
					Enter BIN. If unknown or none, leave blank and click Next.
				</p>

				<WizardField id={binId} label="BIN" fieldKey="bin">
					{(id) => (
						<div className="relative">
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
										setOpen(false);
										onSubmit();
									}
									if (event.key === "Escape") setOpen(false);
								}}
								placeholder="Enter BIN"
							/>
							{open && suggestions.isFetching && visibleOptions.length === 0 ? (
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
													setOpen(false);
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
					)}
				</WizardField>
			</CardContent>
		</Card>
	);
}
