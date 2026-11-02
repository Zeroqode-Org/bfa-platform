"use client";

import { SHOW_WP_ADDRESS_ON_DOCUMENT } from "@bfa-platform/api/lib/result-document-options";
import { valveAnswerLabels } from "@bfa-platform/api/lib/wizard-answer-layout";
import {
	ASSEMBLY_FIELD_KEYS,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	LINE_PRESSURE_UNIT,
	OWNER_ABSENT_DISCLAIMER,
	PRESSURE_DIFFERENCE_UNIT,
	WATER_METER_END_KEY,
	WATER_METER_END_LABEL,
	WATER_METER_START_KEY,
	WATER_METER_START_LABEL,
	WIZARD_TEST_SPEC,
	type WizardQuestion,
} from "@bfa-platform/api/lib/wizard-input";
import { cn } from "@bfa-platform/ui/lib/utils";
import { CircleCheck, CircleX, Square, SquareCheck } from "lucide-react";
import type { ReactNode } from "react";

import { PhotoThumbnail } from "./wizard/photo-thumbnail";
import type { BfaType, WizardValues } from "./wizard/wizard-types";

function show(value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (value === true) return "Yes";
	if (value === false) return "No";

	return String(value);
}

/** A reading with its unit, or a dash when nothing was entered. */
function withUnit(value: unknown, unit: string): string {
	const text = show(value);

	return text === "—" ? text : `${text} ${unit}`;
}

function dateLabel(iso: string | null): string {
	const [year, month, day] = (iso ?? "").split("-");

	return year && month && day ? `${month}/${day}/${year}` : "—";
}

export type TestDocumentProps = {
	/**
	 * `form` — the whole test form as the PDF draws it: the framed card, the
	 * purveyor's heading and the footer (the wizard's review screen).
	 * `sections` — only the inner blocks, for a dialog that already has its
	 * own heading (the submitted-test document).
	 */
	variant?: "form" | "sections";
	/** The purveyor heading — `form` only. */
	wp?: { name: string; address: string | null; pwsid: string | null };
	bfaType: BfaType;
	/** The BIN as the document shows it — the asset's, or what was typed. */
	bin: string;
	wizardData: WizardValues;
	customerName: string;
	customerEmail: string;
	testDate: string | null;
	signatureMethod: string | null;
	signatureData: string | null;
	photoPaths: string[];
	/** Signed links for `photoPaths`, keyed by path. */
	photoUrls: Record<string, string>;
	certifier: {
		fullName?: string | null;
		idNumber?: string | null;
		company?: string | null;
	} | null;
	/** What the sign-off says when there is none: "Not signed yet." before submit. */
	unsignedLabel: string;
};

/**
 * One test laid out as the test form itself — the same sections, rows and
 * order as the results PDF. Drawn by the wizard's review screen (before
 * submit) and by the certifier's submitted-test document (after), so a test
 * looks the same in the wizard, in the archive and on paper.
 */
export function TestDocument({
	variant = "form",
	wp,
	bfaType,
	bin,
	wizardData: data,
	customerName,
	customerEmail,
	testDate,
	signatureMethod,
	signatureData,
	photoPaths,
	photoUrls,
	certifier,
	unsignedLabel,
}: TestDocumentProps) {
	const spec = WIZARD_TEST_SPEC[bfaType];
	const typeCode = bfaType;
	const signed = signatureMethod === "signed";

	const body = (
		<div className="flex shrink-0 flex-col gap-3">
			<Section title="Assembly information">
				<Cells cols={2}>
					<Cell label="BIN" value={bin} />
					<Cell
						label="Service address"
						value={show(data[ASSEMBLY_FIELD_KEYS.serviceAddress])}
					/>
				</Cells>
				<Cells cols={4}>
					<Cell label="Make" value={show(data[ASSEMBLY_FIELD_KEYS.make])} />
					<Cell label="Model" value={show(data[ASSEMBLY_FIELD_KEYS.model])} />
					<Cell
						label="Serial no."
						value={show(data[ASSEMBLY_FIELD_KEYS.serialNumber])}
					/>
					<Cell label="Size" value={show(data[ASSEMBLY_FIELD_KEYS.size])} />
				</Cells>
				<Cells cols={2}>
					<Cell label="Assembly type" value={typeCode} />
					<Cell
						label="Assembly location"
						value={show(data[ASSEMBLY_FIELD_KEYS.location])}
					/>
				</Cells>
			</Section>

			<Section title="Customer information">
				<Cells cols={2}>
					<Cell label="Customer name" value={show(customerName)} />
					<Cell label="Customer email" value={show(customerEmail)} />
				</Cells>
			</Section>

			<Section title={`Initial test — ${typeCode}`}>
				<Cells cols={spec.hasAdp ? 2 : 1}>
					<Cell
						label="Line pressure"
						value={withUnit(data.linePressure, LINE_PRESSURE_UNIT)}
					/>
					{spec.hasAdp ? (
						<Cell
							label="Apparent differential pressure (ADP)"
							value={withUnit(data.adp, PRESSURE_DIFFERENCE_UNIT)}
							highlight
						/>
					) : null}
				</Cells>
				{spec.hasMeter ? (
					<Cells cols={2}>
						<Cell
							label={WATER_METER_START_LABEL}
							value={show(data[WATER_METER_START_KEY])}
						/>
						<Cell
							label={WATER_METER_END_LABEL}
							value={show(data[WATER_METER_END_KEY])}
						/>
					</Cells>
				) : null}

				{spec.sections.map((section) => (
					<div key={section.title ?? "test"} className="flex flex-col gap-2">
						{section.title ? (
							<p className="font-bold text-[12px] text-primary uppercase tracking-wide">
								{section.title}
							</p>
						) : null}
						<div className="border-border border-t border-l">
							{section.questions.map((entry) => (
								<AnswerRow key={entry.key} entry={entry} data={data} />
							))}
						</div>
					</div>
				))}
			</Section>

			<Section title="Property isolation">
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
					<span>Does this assembly isolate the entire property?</span>
					<span className="flex flex-wrap gap-4">
						{(["yes", "no", "undetermined"] as const).map((option) => (
							<Check
								key={option}
								checked={data[ISOLATES_PROPERTY_KEY] === option}
								label={option.charAt(0).toUpperCase() + option.slice(1)}
							/>
						))}
					</span>
				</div>
			</Section>

			<Section title="Initial test result">
				<div className="grid grid-cols-2 gap-3">
					<ResultTile
						kind="pass"
						selected={data[INITIAL_TEST_KEY] === "pass"}
					/>
					<ResultTile
						kind="fail"
						selected={data[INITIAL_TEST_KEY] === "fail"}
					/>
				</div>
			</Section>

			<Section title="Comment">
				<p className="min-h-10 rounded-md bg-muted px-3 py-2 text-[13px]">
					{show(data.comments) === "—" ? "" : show(data.comments)}
				</p>
			</Section>

			<Section title="Certification">
				<Cells cols={3}>
					<Cell label="Initial test by" value={show(certifier?.fullName)} />
					<Cell
						label="Certifier tester no."
						value={show(certifier?.idNumber)}
					/>
					<Cell label="Company" value={show(certifier?.company)} />
				</Cells>
				<Cells cols={3}>
					<Cell label="Initial test date" value={dateLabel(testDate)} />
					<Cell label="Assembly type" value={typeCode} />
					<Cell label="Customer" value={show(customerName)} />
				</Cells>
			</Section>

			<Section title="Assembly owner signature">
				{signed && signatureData ? (
					// biome-ignore lint/performance/noImgElement: a data: URI drawn on this device, not an asset Next can optimise
					<img
						src={signatureData}
						alt="The owner or property manager's signature"
						className="h-20 self-start rounded-md border border-border bg-card p-1"
					/>
				) : signatureMethod === "owner_absent" ? (
					<p className="text-[13px]">{OWNER_ABSENT_DISCLAIMER}</p>
				) : (
					<p className="text-[13px] text-muted-foreground">{unsignedLabel}</p>
				)}
				{photoPaths.length > 0 ? (
					<div className="grid grid-cols-2 gap-3 border-border border-t pt-3">
						{photoPaths.map((path, index) => (
							<div
								key={path}
								className="flex h-40 items-center justify-center overflow-hidden rounded-md border border-border bg-muted"
							>
								<PhotoThumbnail
									path={path}
									src={photoUrls[path]}
									alt={`Attachment ${index + 1} of ${photoPaths.length}`}
									pendingLabel="Loading photo…"
									imageClassName="size-full bg-card object-contain"
								/>
							</div>
						))}
					</div>
				) : null}
				<p className="border-border border-t pt-2 text-[12px] text-muted-foreground">
					{photoPaths.length}{" "}
					{photoPaths.length === 1 ? "attachment" : "attachments"}
				</p>
			</Section>
		</div>
	);

	// `shrink-0` on both: inside a scrolling flex column (the submitted-test
	// dialog's body) a shrinkable item is squeezed to the visible height and
	// clipped, instead of the column scrolling.
	if (variant === "sections") return body;

	return (
		<div className="shrink-0 overflow-hidden rounded-lg border border-border border-t-4 border-t-primary bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
			<header className="mb-4 flex flex-wrap items-start justify-between gap-3">
				<div className="text-[13px]">
					<p className="font-bold text-[15px]">{wp?.name}</p>
					{/* As the results PDF heads it: address (hidden for now — see
					    `SHOW_WP_ADDRESS_ON_DOCUMENT`), then PWSID. */}
					{SHOW_WP_ADDRESS_ON_DOCUMENT && wp?.address ? (
						<p className="text-muted-foreground">{wp.address}</p>
					) : null}
					{wp?.pwsid ? (
						<p className="text-muted-foreground">PWSID {wp.pwsid}</p>
					) : null}
				</div>
				<div className="flex flex-col items-start gap-2 sm:items-end">
					<h3 className="font-bold text-[15px] text-primary uppercase leading-tight sm:text-right">
						Backflow prevention assembly test form
					</h3>
					<span className="rounded-full bg-accent px-3 py-1 font-semibold text-[12px] text-accent-foreground">
						{typeCode} Assembly – Initial Test
					</span>
				</div>
			</header>

			{body}

			<p className="mt-4 rounded-md bg-accent px-3 py-2 text-center font-semibold text-[12px] text-accent-foreground">
				Form generated by Backflow Reporter.io
			</p>
		</div>
	);
}

/** A bordered block of the form with its heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3 rounded-lg border border-border p-3">
			<h4 className="font-bold text-[13px] text-primary uppercase tracking-wide">
				{title}
			</h4>
			{children}
		</section>
	);
}

const COLUMNS = {
	1: "grid-cols-1",
	2: "grid-cols-1 sm:grid-cols-2",
	3: "grid-cols-1 sm:grid-cols-3",
	4: "grid-cols-2 sm:grid-cols-4",
} as const;

/** A row of cells drawn as a ruled table, the way a paper form does. */
function Cells({
	cols,
	children,
}: {
	cols: keyof typeof COLUMNS;
	children: ReactNode;
}) {
	return (
		<div className={cn("grid border-border border-t border-l", COLUMNS[cols])}>
			{children}
		</div>
	);
}

function Cell({
	label,
	value,
	highlight,
}: {
	label: string;
	value: string;
	highlight?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-0.5 border-border border-r border-b px-2.5 py-2",
				highlight && "bg-accent",
			)}
		>
			<span
				className={cn(
					"text-[11px] uppercase tracking-wide",
					highlight ? "text-accent-foreground" : "text-muted-foreground",
				)}
			>
				{label}
			</span>
			<span className="break-words font-semibold text-[13px]">{value}</span>
		</div>
	);
}

/** A ticked or empty box with its word, as on the paper form. */
function Check({ checked, label }: { checked: boolean; label: string }) {
	const Icon = checked ? SquareCheck : Square;

	return (
		<span
			className={cn(
				"flex items-center gap-1.5",
				checked ? "font-semibold text-primary" : "text-muted-foreground",
			)}
		>
			<Icon className="size-4" aria-hidden="true" />
			{label}
		</span>
	);
}

/**
 * One valve: the part on the left, its two answers in the client's terms on
 * the right as ticked boxes, the reading riding on the chosen one — "Opened at
 * 2.0 PSID", "Tight — 2.0 PSID" — as the PDF prints it.
 */
function AnswerRow({
	entry,
	data,
}: {
	entry: WizardQuestion;
	data: Record<string, string | number | boolean | null>;
}) {
	const { answer, yes, no } = valveAnswerLabels(entry, data);

	return (
		<div className="grid grid-cols-1 items-center gap-1 border-border border-r border-b px-2.5 py-2 sm:grid-cols-[1fr_auto] sm:gap-4">
			<span className="font-semibold text-[13px]">{entry.label}</span>
			<span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
				<Check checked={answer === true} label={yes} />
				<Check checked={answer === false} label={no} />
			</span>
		</div>
	);
}

/** The Pass / Fail outcome as two large tiles; the chosen one is filled in its colour. */
function ResultTile({
	kind,
	selected,
}: {
	kind: "pass" | "fail";
	selected: boolean;
}) {
	const pass = kind === "pass";
	const Icon = pass ? CircleCheck : CircleX;

	return (
		<div
			className={cn(
				"flex h-14 items-center justify-center gap-2 rounded-md border font-bold text-[15px] uppercase tracking-wide",
				selected
					? pass
						? "border-success bg-success-bg text-success"
						: "border-danger bg-danger-bg text-danger"
					: "border-border text-muted-foreground",
			)}
		>
			<Icon className="size-5" aria-hidden="true" />
			{pass ? "Pass" : "Fail"}
		</div>
	);
}
