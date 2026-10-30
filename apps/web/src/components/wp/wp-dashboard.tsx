"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@bfa-platform/ui/components/card";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@bfa-platform/ui/components/empty";
import { FieldError } from "@bfa-platform/ui/components/field-message";
import { Label } from "@bfa-platform/ui/components/label";
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import {
	StatCard,
	StatCardSkeleton,
	type StatCardTone,
} from "@bfa-platform/ui/components/stat-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@bfa-platform/ui/components/table";
import {
	useFormValidation,
	type ValidationRules,
} from "@bfa-platform/ui/hooks/use-form-validation";
import {
	isoToUsDate,
	usDate,
	usDateNotBefore,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { useQuery } from "@tanstack/react-query";
import {
	CalendarCheck,
	ClipboardList,
	FileQuestion,
	FileText,
	Inbox,
	ListChecks,
	TriangleAlert,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";

import { trpc } from "@/utils/trpc";

import {
	ComplianceTrendChart,
	PassFailChart,
	UnrecordedNote,
} from "./dashboard-charts";
import type {
	DashboardMetrics,
	DelinquentAsset,
	IncomingReport,
	NoBinReport,
} from "./dashboard-types";
import {
	assetHref,
	daysOverdue,
	defaultBreakdownRange,
	formatCount,
	formatDay,
	formatMonth,
	noBinTestsHref,
	PAST_DUE_LIST_ID,
	pastDueAssetsHref,
	pastDueListHref,
	submittedTestHref,
	submittedTestsHref,
} from "./dashboard-types";
import {
	binLabel,
	TEST_RESULT_LABELS,
	TEST_RESULT_VARIANTS,
} from "./submission-types";

/**
 * The Water Purveyor home screen.
 *
 * Five numbers, two work queues, two charts — every one of them derived from
 * rows belonging to the caller's own purveyor, because the procedures behind
 * them take their tenant from `ctx.caller.waterPurveyorId` and accept no input
 * naming one. There is nothing on this screen a client could ask a different
 * question with.
 *
 * Five queries rather than one, and deliberately: `httpBatchLink` sends them as
 * a single HTTP request anyway, so the cost is nothing, and each panel gets to
 * fail, load and empty on its own. A single combined query would mean a slow
 * trend hiding the cards, and one broken panel blanking the screen.
 *
 * **The cards are the build plan's five** (§ 6.4.1), not the prototype's six.
 * The approved prototype also shows Certifiers and Customers; the build plan is
 * authoritative on what this screen counts, and both of those already have a
 * screen of their own in the sidebar. That deviation is intentional and
 * recorded in the docs.
 */
export function WpDashboard({ today }: { today: string }) {
	// Seeded from the server's `today` rather than from the browser clock: this
	// component renders on the server first, and a default computed from
	// `new Date()` would be computed twice, a moment apart, either side of the
	// hydration boundary. Held as the `MM/DD/YYYY` text in the boxes; the ISO days
	// the procedure takes are derived from it below.
	const [range, setRange] = useState(() => displayedBreakdownRange(today));

	// Two ways a range can be unusable, and they are different problems with
	// different answers, so the screen tells them apart.
	//
	// *Incomplete* is a cleared or half-typed box — an ordinary step on the way
	// to typing a different date. Sending it would get it refused by
	// `z.iso.date()`, and a refusal surfaces as a failed request: the screen
	// would report that something went wrong when the truth is the reader is
	// mid-edit.
	//
	// *Backwards* is both dates filled in and the wrong way round. A typo, not
	// an empty result — reporting it as two zeroes would let somebody conclude
	// nobody tested anything that month.
	//
	// Neither is sent. The server's own validation is untouched and is still the
	// boundary; this only decides whether there is a question worth asking yet.
	// The backwards case keeps the wording the Submitted Tests filters use.
	const fromIso = usDateToIso(range.from);
	const toIso = usDateToIso(range.to);
	const rangeIsComplete = fromIso !== null && toIso !== null;
	const rangeIsBackwards =
		fromIso !== null && toIso !== null && fromIso > toIso;
	const rangeIsUsable = rangeIsComplete && !rangeIsBackwards;

	// A box holding something that is not a date says so under itself, and the
	// end box says so when it comes before the start.
	const rangeValidation = useFormValidation({
		values: range,
		rules: BREAKDOWN_RANGE_RULES,
	});

	const metrics = useQuery(trpc.dashboard.dashboardMetrics.queryOptions());
	const trend = useQuery(trpc.dashboard.complianceTrend.queryOptions());
	const incoming = useQuery(trpc.dashboard.incomingReports.queryOptions({}));
	const delinquent = useQuery(trpc.dashboard.delinquentAssets.queryOptions({}));
	const noBin = useQuery(
		trpc.dashboard.noBinReports.queryOptions({ limit: NO_BIN_TABLE_LIMIT }),
	);
	const breakdown = useQuery(
		trpc.dashboard.passFailBreakdown.queryOptions(
			{ from: fromIso ?? "", to: toIso ?? "" },
			{
				// Filling the blank box back in flips this to true and the query runs
				// itself — there is nothing for the reader to press.
				enabled: rangeIsUsable,
			},
		),
	);

	return (
		<div className="flex flex-col gap-5">
			<section aria-label="Key figures">
				<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
					{metrics.isPending ? (
						CARDS.map((card) => (
							<StatCardSkeleton key={card.key} tone={card.tone} />
						))
					) : metrics.isError ? (
						<Card className="col-span-full">
							<CardContent>
								<StateBlock
									tone="danger"
									title="Couldn&rsquo;t load your figures"
									description={metrics.error.message}
									onRetry={() => metrics.refetch()}
								/>
							</CardContent>
						</Card>
					) : (
						CARDS.map((card) => {
							const stat = (
								<StatCard
									key={card.href ? undefined : card.key}
									tone={card.tone}
									icon={<card.Icon strokeWidth={1.8} />}
									label={card.label}
									value={formatCount(metrics.data[card.key])}
									hint={
										card.key === "testsThisMonth"
											? formatMonth(metrics.data.month)
											: card.hint
									}
									className={
										card.href
											? "h-full transition-colors hover:border-danger/40"
											: undefined
									}
								/>
							);

							// The Past due card jumps to the Past Due list further down
							// this screen — the client's call, replacing the build
							// plan's handoff to the fail list, which now has its own
							// sidebar entry. A link around the card rather than an
							// onClick, so it announces as a link.
							return card.href ? (
								<Link
									key={card.key}
									href={card.href()}
									aria-label={`${card.label} — show the past due list`}
									className="rounded-xl focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
								>
									{stat}
								</Link>
							) : (
								stat
							);
						})
					)}
				</div>
			</section>

			<section aria-label="No-BIN reports">
				<Card>
					<CardHeader>
						<CardTitle>No-BIN reports</CardTitle>
						<CardDescription>
							Tests submitted without a BIN. Each registered a new asset with no
							BIN — open it to assign the BIN and attach the customer, or link
							the test to an assembly you already have. Notices for it start
							once it has a BIN.
						</CardDescription>
						<CardAction>
							<ViewAllLink href={noBinTestsHref()} list="no-BIN reports" />
						</CardAction>
					</CardHeader>
					<CardContent>
						{noBin.isPending ? (
							<ListSkeleton />
						) : noBin.isError ? (
							<StateBlock
								tone="danger"
								title="Couldn&rsquo;t load no-BIN reports"
								description={noBin.error.message}
								onRetry={() => noBin.refetch()}
							/>
						) : noBin.data.length === 0 ? (
							<StateBlock
								icon={<ListChecks />}
								title="Every test has a BIN"
								description="A test submitted without a BIN appears here until you assign one."
							/>
						) : (
							<NoBinTable reports={noBin.data} />
						)}
					</CardContent>
				</Card>
			</section>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<section aria-label="Incoming reports" className="flex">
					<Card className="w-full">
						<CardHeader>
							<CardTitle>Incoming reports</CardTitle>
							<CardDescription>
								The newest tests filed against you. Opening one takes you to
								Submitted Tests, where you can correct it.
							</CardDescription>
							<CardAction>
								<ViewAllLink
									href={submittedTestsHref()}
									list="submitted tests"
								/>
							</CardAction>
						</CardHeader>
						<CardContent>
							{incoming.isPending ? (
								<ListSkeleton />
							) : incoming.isError ? (
								<StateBlock
									tone="danger"
									title="Couldn&rsquo;t load incoming reports"
									description={incoming.error.message}
									onRetry={() => incoming.refetch()}
								/>
							) : incoming.data.length === 0 ? (
								<StateBlock
									icon={<Inbox />}
									title="Nothing filed yet"
									description="A test appears here the moment a certifier submits one against your purveyor. Drafts never do."
								/>
							) : (
								<ul className="flex flex-col">
									{incoming.data.map((report) => (
										<IncomingRow key={report.id} report={report} />
									))}
								</ul>
							)}
						</CardContent>
					</Card>
				</section>

				<section
					id={PAST_DUE_LIST_ID}
					aria-label="Past Due"
					className="flex scroll-mt-5"
				>
					<Card className="w-full">
						<CardHeader>
							<CardTitle>Past Due</CardTitle>
							<CardDescription>
								Past due, worst first — every assembly whose annual test date
								has passed.
							</CardDescription>
							<CardAction>
								<ViewAllLink
									href={pastDueAssetsHref()}
									list="past due assets"
								/>
							</CardAction>
						</CardHeader>
						<CardContent>
							{delinquent.isPending ? (
								<ListSkeleton />
							) : delinquent.isError ? (
								<StateBlock
									tone="danger"
									title="Couldn&rsquo;t load past due assets"
									description={delinquent.error.message}
									onRetry={() => delinquent.refetch()}
								/>
							) : delinquent.data.length === 0 ? (
								<StateBlock
									icon={<CalendarCheck />}
									title="Nothing is past due"
									description="Every assembly you are responsible for is inside its annual test window."
								/>
							) : (
								<ul className="flex flex-col">
									{delinquent.data.map((asset) => (
										<DelinquentRow key={asset.id} asset={asset} today={today} />
									))}
								</ul>
							)}
						</CardContent>
					</Card>
				</section>
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<section aria-label="Compliance trend" className="flex">
					<Card className="w-full">
						<CardHeader>
							<CardTitle>Compliance trend</CardTitle>
							<CardDescription>
								Pass rate by month over the last twelve. Only tests carrying a
								recorded result are counted.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{trend.isPending ? (
								<Skeleton className="h-[240px] w-full rounded-lg" />
							) : trend.isError ? (
								<StateBlock
									tone="danger"
									title="Couldn&rsquo;t load the compliance trend"
									description={trend.error.message}
									onRetry={() => trend.refetch()}
								/>
							) : (
								<ComplianceTrendChart months={trend.data.months} />
							)}
						</CardContent>
					</Card>
				</section>

				<section aria-label="Pass / fail breakdown" className="flex">
					<Card className="w-full">
						<CardHeader>
							<CardTitle>Pass / fail breakdown</CardTitle>
							<CardDescription>
								Results by test date. Both dates are included in the range.
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-4">
							<div className="flex flex-wrap items-end gap-3">
								<div className="flex w-[170px] flex-col gap-1.5">
									<Label
										htmlFor={rangeValidation.fieldId("from")}
										className="text-[12px] text-muted-foreground"
									>
										Tested from
									</Label>
									<DateInput
										pickerLabel="Choose tested-from date"
										{...rangeValidation.controlProps("from")}
										value={range.from}
										onValueChange={(value) =>
											setRange((current) => ({ ...current, from: value }))
										}
									/>
									<FieldError {...rangeValidation.errorProps("from")} />
								</div>
								<div className="flex w-[170px] flex-col gap-1.5">
									<Label
										htmlFor={rangeValidation.fieldId("to")}
										className="text-[12px] text-muted-foreground"
									>
										Tested to
									</Label>
									<DateInput
										pickerLabel="Choose tested-to date"
										{...rangeValidation.controlProps("to")}
										value={range.to}
										onValueChange={(value) =>
											setRange((current) => ({ ...current, to: value }))
										}
									/>
									<FieldError {...rangeValidation.errorProps("to")} />
								</div>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => {
										setRange(displayedBreakdownRange(today));
										rangeValidation.reset();
									}}
								>
									Last 12 months
								</Button>
							</div>

							{!rangeIsComplete ? (
								/* Names the box that is actually empty. "Pick both dates"
								   when somebody has cleared the pair is honest; saying it
								   when only one is blank would make them check the one
								   they already filled in. */
								<StateBlock
									tone="warning"
									title={
										fromIso
											? "Pick an end date"
											: toIso
												? "Pick a start date"
												: "Pick both dates"
									}
									description="The breakdown counts results between two dates, so it needs both before it can count anything."
								/>
							) : rangeIsBackwards ? (
								<StateBlock
									tone="warning"
									title="That date range runs backwards"
									description="&ldquo;Tested to&rdquo; is earlier than &ldquo;tested from&rdquo;, so nothing could fall inside it."
								/>
							) : breakdown.isPending ? (
								<Skeleton className="h-[120px] w-full rounded-lg" />
							) : breakdown.isError ? (
								<StateBlock
									tone="danger"
									title="Couldn&rsquo;t load the breakdown"
									description={breakdown.error.message}
									onRetry={() => breakdown.refetch()}
								/>
							) : (
								/* Note what is *not* here: a zero total is not an empty state.
							   The chart renders both bars at zero and says so, because
							   "nobody tested anything in this window" is a finding, and
							   replacing it with a placeholder would hide it.

							   The unrecorded count is a sibling of the chart rather than
							   part of it — `supplemental` on the response, its own note on
							   the screen. Worth telling a purveyor about; not a third
							   bar. */
								<>
									<PassFailChart breakdown={breakdown.data} />
									<UnrecordedNote
										count={breakdown.data.supplemental.unrecorded}
									/>
								</>
							)}
						</CardContent>
					</Card>
				</section>
			</div>
		</div>
	);
}

type DisplayedRange = { from: string; to: string };

/** The default breakdown window, spelled the way the date boxes show it. */
function displayedBreakdownRange(today: string): DisplayedRange {
	const range = defaultBreakdownRange(today);

	return { from: isoToUsDate(range.from), to: isoToUsDate(range.to) };
}

/**
 * Each box must hold a real date, and the end may not come before the start.
 * An empty box is not a field error here — the panel below names it.
 */
const BREAKDOWN_RANGE_RULES: ValidationRules<DisplayedRange> = {
	from: usDate(),
	to: (value, range) => usDate()(value) ?? usDateNotBefore(range.from)(value),
};

/**
 * The five cards, in the build plan's order.
 *
 * A table rather than five copies of the same JSX, so the tone vocabulary is
 * visible in one place: primary for a figure counted straight off a table,
 * accent for one computed over a period or a condition, danger for the one that
 * means somebody has to act.
 *
 * The `key` is the field name on `dashboardMetrics`, so a card cannot be
 * labelled with one number and filled from another.
 */
type DashboardCard = {
	/** A counted metric only — `month`, the window label, is not a card. */
	key: Exclude<keyof DashboardMetrics, "month">;
	label: string;
	tone: StatCardTone;
	Icon: typeof ClipboardList;
	hint: string | undefined;
	/** Where the whole card links, for the cards that are also a door. */
	href?: () => Route;
};

const CARDS: readonly DashboardCard[] = [
	{
		key: "totalAssets",
		label: "Total assets",
		tone: "primary",
		Icon: ClipboardList,
		hint: "Every assembly on your system",
	},
	{
		key: "testsThisMonth",
		label: "Tests this month",
		tone: "accent",
		Icon: CalendarCheck,
		// Replaced at render with the month the server measured, so the card
		// cannot claim a month the number did not come from.
		hint: undefined,
	},
	{
		key: "pastDue",
		label: "Past due",
		tone: "danger",
		Icon: TriangleAlert,
		hint: "Assets outside their test window — see the list below",
		// The card's number is the past-due count, from each asset's annual test
		// date as of today, so it opens the list of those same assets.
		href: pastDueListHref,
	},
	{
		key: "submittedReports",
		label: "Submitted reports",
		tone: "primary",
		Icon: FileText,
		// Says what the number is, because the build plan called this card
		// "awaiting review" and the schema has no review state to drain. It
		// counts what has come in, and it does not go down.
		hint: "Filed to date — not a review queue",
	},
	{
		key: "noBinSubmissions",
		label: "No-BIN submissions",
		tone: "accent",
		Icon: FileQuestion,
		hint: "Waiting for a BIN — see the table below",
	},
];

/** How many no-BIN reports the dashboard table shows — the card has the total. */
const NO_BIN_TABLE_LIMIT = 10;

/**
 * The No-BIN table: one row per test still waiting for a BIN, the newest
 * first. A row opens the work: the no-BIN asset the wizard registered, where
 * the BIN is assigned and the customer attached — or, for a test filed before
 * those assets existed, the test itself, where the BIN is typed as before.
 */
function NoBinTable({ reports }: { reports: NoBinReport[] }) {
	return (
		<Table className="whitespace-nowrap">
			<TableHeader>
				<TableRow>
					<TableHead>Test date</TableHead>
					<TableHead>BFA type</TableHead>
					<TableHead>Service address</TableHead>
					<TableHead>Certifier</TableHead>
					<TableHead>Customer</TableHead>
					<TableHead>Result</TableHead>
					<TableHead>
						<span className="sr-only">Action</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{reports.map((report) => (
					<TableRow key={report.id}>
						<TableCell>{formatDay(report.testDate)}</TableCell>
						<TableCell className="text-muted-foreground">
							{report.bfaType}
						</TableCell>
						<TableCell className="max-w-[260px] truncate">
							{report.serviceAddress ?? "—"}
						</TableCell>
						<TableCell className="text-muted-foreground">
							{report.certifierName ?? "Unnamed certifier"}
						</TableCell>
						<TableCell>
							{report.hasCustomer ? (
								<Badge variant="success">Attached</Badge>
							) : (
								<Badge variant="warning">Not attached</Badge>
							)}
						</TableCell>
						<TableCell>
							{report.testResult ? (
								<Badge variant={TEST_RESULT_VARIANTS[report.testResult]}>
									{TEST_RESULT_LABELS[report.testResult]}
								</Badge>
							) : (
								<Badge variant="neutral">No result</Badge>
							)}
						</TableCell>
						<TableCell className="text-right">
							<Link
								href={
									report.bfaAssetId
										? assetHref(report.bfaAssetId)
										: submittedTestHref(report.id)
								}
								className="font-semibold text-[13px] text-primary hover:underline"
							>
								{report.bfaAssetId ? "Assign BIN" : "Open test"}
							</Link>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/**
 * One incoming report.
 *
 * The whole row is the link, because the whole row is one record and a reader
 * aiming at a five-character BIN is aiming at the wrong thing. It goes to
 * `/wp/tests?test=<id>` — the existing Submitted Tests screen, which opens the
 * record in its document dialog. Nothing about the document, the corrections
 * form or the role check is re-implemented here.
 */
function IncomingRow({ report }: { report: IncomingReport }) {
	const bin = binLabel(report);

	return (
		<li className="border-border-soft border-b last:border-b-0">
			<Link
				href={submittedTestHref(report.id)}
				className="flex items-center justify-between gap-3 rounded-md px-1 py-2.5 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
			>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-semibold text-[13.5px] text-foreground">
						{bin.text}
						<span className="ml-2 font-normal text-[12px] text-muted-foreground">
							{report.bfaType}
						</span>
					</span>
					<span className="truncate text-[12px] text-muted-foreground">
						{report.certifierName ?? "Unnamed certifier"} ·{" "}
						{formatDay(report.testDate)}
					</span>
					{bin.resolved ? null : (
						<span className="text-[11px] text-warning">Waiting for a BIN</span>
					)}
				</span>

				{report.testResult ? (
					<Badge variant={TEST_RESULT_VARIANTS[report.testResult]}>
						{TEST_RESULT_LABELS[report.testResult]}
					</Badge>
				) : (
					<Badge variant="neutral">No result</Badge>
				)}
			</Link>
		</li>
	);
}

/**
 * The way out of a capped home list into the full screen behind it. The lists
 * show the first few rows only (`HOME_LIST_DEFAULT_LIMIT`, or the no-BIN
 * table's own cap), so without this a reader with more rows than that has no
 * way to see the rest from here.
 */
function ViewAllLink({ href, list }: { href: Route; list: string }) {
	return (
		<Link
			href={href}
			aria-label={`View all ${list}`}
			className="whitespace-nowrap rounded-sm font-medium text-[13px] text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
		>
			View all
		</Link>
	);
}

/** One past-due asset, linking to the asset's own detail route. */
function DelinquentRow({
	asset,
	today,
}: {
	asset: DelinquentAsset;
	today: string;
}) {
	const overdue = daysOverdue(asset.annualTestDate, today);

	return (
		<li className="border-border-soft border-b last:border-b-0">
			<Link
				href={assetHref(asset.id)}
				className="flex items-center justify-between gap-3 rounded-md px-1 py-2.5 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
			>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-semibold text-[13.5px] text-foreground">
						{asset.bin ?? "No BIN"}
						<span className="ml-2 font-normal text-[12px] text-muted-foreground">
							{asset.bfaType}
						</span>
					</span>
					<span className="truncate text-[12px] text-muted-foreground">
						{asset.serviceAddress}
						{asset.currentCustomerName ? ` · ${asset.currentCustomerName}` : ""}
					</span>
					<span className="text-[11px] text-text-tertiary">
						Due {formatDay(asset.annualTestDate)}
					</span>
				</span>

				<Badge variant="danger">
					{overdue === null
						? "Past due"
						: `${formatCount(overdue)} ${overdue === 1 ? "day" : "days"}`}
				</Badge>
			</Link>
		</li>
	);
}

/**
 * The one loading, empty and error block every panel on this screen uses.
 *
 * Built on the project's `Empty` primitives rather than a local layout, so a
 * failed panel here looks like a failed table on the Assets or Submitted Tests
 * screen. Three tones because the icon carries the difference between "nothing
 * happened", "something is wrong with your input", and "the request failed" —
 * and a reader should not have to parse the sentence to tell them apart.
 */
function StateBlock({
	tone = "neutral",
	icon,
	title,
	description,
	onRetry,
}: {
	tone?: "neutral" | "warning" | "danger";
	icon?: React.ReactNode;
	title: string;
	description: string;
	onRetry?: () => void;
}) {
	const toneIcon =
		tone === "danger" ? (
			<TriangleAlert className="text-danger" />
		) : tone === "warning" ? (
			<TriangleAlert className="text-warning" />
		) : (
			icon
		);

	return (
		<Empty className="p-6">
			<EmptyHeader>
				<EmptyMedia variant="icon">{toneIcon}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{onRetry ? (
				<Button variant="secondary" size="sm" onClick={onRetry}>
					Try again
				</Button>
			) : null}
		</Empty>
	);
}

/** Placeholder rows at the height the real ones will occupy. */
function ListSkeleton() {
	return (
		<ul className="flex flex-col">
			{Array.from({ length: 5 }, (_, index) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
					key={index}
					className="border-border-soft border-b py-3 last:border-b-0"
				>
					<Skeleton className="h-4 w-2/5 rounded-sm" />
					<Skeleton className="mt-1.5 h-3 w-3/5 rounded-sm" />
				</li>
			))}
		</ul>
	);
}
