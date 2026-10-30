"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@bfa-platform/ui/components/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@bfa-platform/ui/components/empty";
import { FieldError } from "@bfa-platform/ui/components/field-message";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@bfa-platform/ui/components/table";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	isoToUsDate,
	usDate,
	usDateNotBefore,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { FileText, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { trpc } from "@/utils/trpc";
import {
	hawaiiToday,
	type StatementPeriod,
	statementPeriods,
} from "./statement-periods";
import {
	SubmissionDocument,
	SubmissionDocumentError,
	SubmissionDocumentSkeleton,
} from "./submission-document";
import type { Submission, SubmissionResult } from "./submission-types";
import {
	binLabel,
	canEditSubmissions,
	formatSubmissionDate,
	TEST_RESULT_LABELS,
	TEST_RESULT_VARIANTS,
} from "./submission-types";
import {
	type ExportFilters,
	SubmittedTestsExportButton,
} from "./submitted-tests-export";

/** The result filter, with the unfiltered case as a value rather than absence. */
const RESULT_FILTERS = {
	all: "All results",
	pass: TEST_RESULT_LABELS.pass,
	fail: TEST_RESULT_LABELS.fail,
} as const;

type ResultFilter = keyof typeof RESULT_FILTERS;

/**
 * The BIN filter. "No BIN" is the dashboard's No-BIN card, row for row: the
 * server applies the same predicate that card counts with, so following its
 * "View all" here shows the number the card showed.
 */
const BIN_FILTERS = {
	all: "All BINs",
	none: "No BIN",
} as const;

type BinFilter = keyof typeof BIN_FILTERS;

const COLUMN_COUNT = 7;
const SKELETON_ROWS = 6;
const PAGE_SIZE = 25;

/**
 * Every submitted test filed against this water purveyor, across every
 * certifier who works for them.
 *
 * Drafts are not here, and not because they are filtered out of a list that
 * could show them: `listSubmittedTests` pins `status = 'submitted'`, and so do
 * the row policies behind it. A draft is a certifier's working copy of a test
 * that has not been attested to, and a purveyor reading one would be reading
 * something nobody has stood behind yet.
 *
 * The columns are limited to facts every submitted row actually carries — BIN,
 * customer, type, date, result, certifier. The customer is whoever occupied
 * the asset on the test date, the same name the CSV statement puts on the
 * line, so the table a WP checks before downloading agrees with the file.
 * The per-BFA-type readings live in the document
 * view, because a column for them would either be eight columns or one that
 * means something different on every line.
 */
export function SubmittedTestsTable({
	initialSubmissionId,
	initialNoBin = false,
}: {
	/**
	 * A record to open on arrival, named in the URL as `?test=<id>`.
	 *
	 * This is how the dashboard's incoming-reports list drills in: it links to
	 * this screen rather than to a detail view of its own, so the document, the
	 * corrections form, the link-to-asset flow and the role check are this
	 * screen's single copy of each.
	 *
	 * Initial state rather than a controlled prop — closing the dialog has to
	 * leave the reader on the list they arrived at, not reopen the record
	 * because the query string still says so. The id is read on the server from
	 * `searchParams` and handed down; nothing here trusts it, because
	 * `getSubmittedTest` scopes by tenant and status and answers a foreign id,
	 * a draft id and an invented one identically.
	 */
	initialSubmissionId?: string;
	/**
	 * Start on the no-BIN tests only, named in the URL as `?bin=none`.
	 *
	 * How the dashboard's No-BIN list, which shows ten rows, offers the rest:
	 * its "View all" lands here rather than on a no-BIN screen of its own, so
	 * the paging, the export and the link-to-asset flow stay this screen's.
	 * Initial state for the same reason as `initialSubmissionId` — the reader
	 * can widen the filter afterwards without the URL putting it back.
	 */
	initialNoBin?: boolean;
} = {}) {
	const queryClient = useQueryClient();

	const [page, setPage] = useState(1);
	const [result, setResult] = useState<ResultFilter>("all");
	const [bin, setBin] = useState<BinFilter>(initialNoBin ? "none" : "all");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [openSubmissionId, setOpenSubmissionId] = useState<string | null>(
		initialSubmissionId ?? null,
	);

	// The boxes hold `MM/DD/YYYY` text; the procedure takes ISO days. A blank box
	// is no bound. A box holding something that is not a real date is neither a
	// bound nor "no bound" — dropping it would quietly widen the list — so
	// nothing is asked until it is fixed, and its own message says why.
	const fromIso = from.trim() ? usDateToIso(from) : undefined;
	const toIso = to.trim() ? usDateToIso(to) : undefined;
	const rangeHasInvalidDate = fromIso === null || toIso === null;

	// A range typed backwards is a typo, and the server refuses it. Catching it
	// here keeps the screen from reporting a validation error as a failed
	// request, and says which of the two boxes is the problem.
	const rangeIsBackwards = Boolean(fromIso && toIso && fromIso > toIso);

	const rangeValidation = useFormValidation({
		values: { from, to },
		rules: {
			from: usDate(),
			to: (value, range) =>
				usDate()(value) ?? usDateNotBefore(range.from)(value),
		},
	});

	// A narrowed list is a different list: staying on page 4 of it would show an
	// empty page and read as "no tests".
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the pager when the filters change, not when the page does
	useEffect(() => {
		setPage(1);
	}, [result, bin, from, to]);

	// Built once and handed to both the list and the CSV button, so a filter
	// added to one cannot be missing from the other and download rows the
	// table does not show.
	const filters: ExportFilters = {
		result: result === "all" ? undefined : (result as SubmissionResult),
		bin: bin === "none" ? "none" : undefined,
		from: fromIso ?? undefined,
		to: toIso ?? undefined,
	};

	const { data, isPending, isError, error, refetch, isPlaceholderData } =
		useQuery(
			trpc.submittedTests.listSubmittedTests.queryOptions(
				{ page, pageSize: PAGE_SIZE, ...filters },
				{
					// Keeps the previous page on screen while the next one loads, so
					// paging does not blink the whole table back to skeletons.
					placeholderData: keepPreviousData,
					enabled: !rangeIsBackwards && !rangeHasInvalidDate,
				},
			),
		);

	// The role decides which controls the document offers. The two write
	// procedures refuse an Employee regardless — this is the screen not offering
	// an action it knows would fail, not the boundary.
	//
	// `undefined` while it is in flight, rather than defaulting to "cannot".
	// Defaulting either way would flash the wrong document at somebody for as
	// long as the request takes: an Admin told they may only read, or an
	// Employee shown fields that are about to be taken away. The dialog waits.
	const whoami = useQuery(trpc.whoami.queryOptions());
	const canEdit = whoami.isPending
		? undefined
		: canEditSubmissions(whoami.data?.globalRole);

	const hasFilters =
		result !== "all" || bin !== "all" || Boolean(from) || Boolean(to);
	const total = data?.total ?? 0;

	// Computed once per mount: a clerk who leaves the screen open past midnight
	// gets yesterday's "this month" until they navigate, which is harmless —
	// every preset only fills the two boxes, and the boxes are what is sent.
	const [periods] = useState(() => statementPeriods(hawaiiToday()));
	const activePeriod = periods.find(
		(period) => period.from === fromIso && period.to === toIso,
	);

	function applyPeriod(period: StatementPeriod) {
		setFrom(isoToUsDate(period.from));
		setTo(isoToUsDate(period.to));
		rangeValidation.reset();
	}

	// Nothing to download while the boxes do not form a range the server can
	// answer — the table's own empty state and the field errors say why.
	const rangeIsUsable = !rangeIsBackwards && !rangeHasInvalidDate;

	function clearFilters() {
		setResult("all");
		setBin("all");
		setFrom("");
		setTo("");
		rangeValidation.reset();
	}

	async function refreshAfterChange() {
		await queryClient.invalidateQueries({
			queryKey: trpc.submittedTests.listSubmittedTests.queryKey(),
		});
		if (openSubmissionId) {
			await queryClient.invalidateQueries({
				queryKey: trpc.submittedTests.getSubmittedTest.queryKey({
					id: openSubmissionId,
				}),
			});
		}
		// Linking a submission to an asset does not change the asset, but it does
		// change what the assets screen's cached rows mean next to it — and the
		// document's own asset search is one of these queries.
		await queryClient.invalidateQueries({
			queryKey: trpc.assets.listAssets.queryKey(),
		});
		// Assigning a BIN to an unlinked test can register a customer along with
		// the new asset.
		await queryClient.invalidateQueries({
			queryKey: trpc.customers.listCustomers.queryKey(),
		});
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1.5">
					<Label className="text-[12px] text-muted-foreground">Result</Label>
					<Select
						items={RESULT_FILTERS}
						value={result}
						onValueChange={(value) => setResult(value as ResultFilter)}
					>
						<SelectTrigger aria-label="Filter by result" className="w-[160px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{Object.entries(RESULT_FILTERS).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label className="text-[12px] text-muted-foreground">BIN</Label>
					<Select
						items={BIN_FILTERS}
						value={bin}
						onValueChange={(value) => setBin(value as BinFilter)}
					>
						<SelectTrigger aria-label="Filter by BIN" className="w-[140px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{Object.entries(BIN_FILTERS).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>

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
						value={from}
						onValueChange={setFrom}
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
						value={to}
						onValueChange={setTo}
					/>
					<FieldError {...rangeValidation.errorProps("to")} />
				</div>

				{hasFilters ? (
					<Button variant="secondary" size="sm" onClick={clearFilters}>
						Clear filters
					</Button>
				) : null}
			</div>

			{/* The statement row: quick periods on the left, the download on the
			    right. Each period only fills the two date boxes — the boxes stay
			    the single source of the range, so a preset can be adjusted by
			    hand afterwards like any typed date. */}
			<div className="-mt-1 flex flex-wrap items-center justify-between gap-3">
				<fieldset
					aria-label="Quick periods"
					className="flex min-w-0 flex-wrap items-center gap-2"
				>
					{periods.map((period) => {
						const active = activePeriod?.key === period.key;

						return (
							<Button
								key={period.key}
								variant="outline"
								size="xs"
								aria-pressed={active}
								onClick={() => applyPeriod(period)}
								className={
									active
										? "border-accent bg-accent text-accent-foreground hover:bg-accent"
										: undefined
								}
							>
								{period.label}
							</Button>
						);
					})}
				</fieldset>

				{/* Takes the same filters the query above does, so what downloads
				    is what the table holds — every page of it, as the count on
				    the button says. */}
				<SubmittedTestsExportButton
					filters={filters}
					count={rangeIsUsable && data ? total : undefined}
					disabled={
						!rangeIsUsable ||
						!data ||
						isError ||
						isPlaceholderData ||
						total === 0
					}
				/>
			</div>

			<div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>BIN</TableHead>
							<TableHead>Customer</TableHead>
							<TableHead>BFA type</TableHead>
							<TableHead>Test date</TableHead>
							<TableHead>Result</TableHead>
							<TableHead>Certifier</TableHead>
							<TableHead>
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rangeIsBackwards ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<TriangleAlert className="text-warning" />
										</EmptyMedia>
										<EmptyTitle>That date range runs backwards</EmptyTitle>
										<EmptyDescription>
											“Tested to” is earlier than “tested from”, so nothing
											could fall inside it.
										</EmptyDescription>
									</EmptyHeader>
									<Button variant="secondary" size="sm" onClick={clearFilters}>
										Clear filters
									</Button>
								</Empty>
							</StateRow>
						) : isPending ? (
							<LoadingRows />
						) : isError ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<TriangleAlert className="text-danger" />
										</EmptyMedia>
										<EmptyTitle>Couldn&rsquo;t load submitted tests</EmptyTitle>
										<EmptyDescription>{error.message}</EmptyDescription>
									</EmptyHeader>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => refetch()}
									>
										Try again
									</Button>
								</Empty>
							</StateRow>
						) : data.rows.length === 0 ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<FileText />
										</EmptyMedia>
										{/* Two different nothings: a purveyor nobody has filed
										    against yet is waiting on certifiers; a filtered
										    list needs to know the filter is what emptied it. */}
										<EmptyTitle>
											{hasFilters
												? "No tests match these filters"
												: "No submitted tests yet"}
										</EmptyTitle>
										<EmptyDescription>
											{hasFilters
												? "Try a wider date range, or all results and BINs."
												: "Tests appear here the moment a certifier submits one against your purveyor. Drafts never do."}
										</EmptyDescription>
									</EmptyHeader>
									{hasFilters ? (
										<Button
											variant="secondary"
											size="sm"
											onClick={clearFilters}
										>
											Clear filters
										</Button>
									) : null}
								</Empty>
							</StateRow>
						) : (
							data.rows.map((submission) => (
								<SubmissionRow
									key={submission.id}
									submission={submission}
									onOpen={() => setOpenSubmissionId(submission.id)}
								/>
							))
						)}
					</TableBody>
				</Table>
			</div>

			<div className="flex flex-wrap items-center justify-end gap-3">
				{data && data.pageCount > 1 ? (
					<div className="flex items-center gap-2">
						<Button
							variant="secondary"
							size="sm"
							disabled={page <= 1 || isPlaceholderData}
							onClick={() => setPage((current) => Math.max(1, current - 1))}
						>
							Previous
						</Button>
						<span className="text-[13px] text-muted-foreground tabular-nums">
							Page {data.page} of {data.pageCount}
						</span>
						<Button
							variant="secondary"
							size="sm"
							disabled={page >= data.pageCount || isPlaceholderData}
							onClick={() => setPage((current) => current + 1)}
						>
							Next
						</Button>
					</div>
				) : null}
			</div>

			<SubmissionDialog
				submissionId={openSubmissionId}
				canEdit={canEdit}
				onOpenChange={(open) => {
					if (!open) setOpenSubmissionId(null);
				}}
				onChanged={refreshAfterChange}
			/>
		</div>
	);
}

/** One filed test. The BIN opens it, because the BIN is what a reader looks for. */
function SubmissionRow({
	submission,
	onOpen,
}: {
	submission: Submission;
	onOpen: () => void;
}) {
	const bin = binLabel(submission);

	return (
		<TableRow>
			<TableCell className="font-semibold">
				<div className="flex flex-col items-start gap-1">
					<button
						type="button"
						onClick={onOpen}
						className="text-primary hover:underline"
					>
						{bin.text}
					</button>
					{/* An unresolved submission is attached to no assembly, which is a
					    fact about the row rather than a detail inside it — the reader
					    scanning this list is looking for exactly these. */}
					{bin.resolved ? null : (
						<span className="font-normal text-[11px] text-warning">
							Not linked to an asset
						</span>
					)}
				</div>
			</TableCell>
			{/* Whoever occupied the asset on the test date — the same name the
			    CSV statement puts on this line. */}
			<TableCell>
				{submission.customerName ?? (
					<span className="text-muted-foreground">—</span>
				)}
			</TableCell>
			<TableCell className="text-muted-foreground">
				{submission.bfaType}
			</TableCell>
			<TableCell className="tabular-nums">
				{formatSubmissionDate(submission.testDate)}
			</TableCell>
			<TableCell>
				{submission.testResult ? (
					<Badge variant={TEST_RESULT_VARIANTS[submission.testResult]}>
						{TEST_RESULT_LABELS[submission.testResult]}
					</Badge>
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</TableCell>
			<TableCell>{submission.certifierName}</TableCell>
			<TableCell className="text-right">
				<Button variant="secondary" size="sm" onClick={onOpen}>
					Open
				</Button>
			</TableCell>
		</TableRow>
	);
}

/**
 * The document view, in a modal over the list.
 *
 * A dialog rather than its own route because a WP working through submissions
 * opens several in a row — checking a reading, answering a certifier's call —
 * and coming back to the same filtered page each time is the whole job. The
 * record is fetched by id rather than handed over from the row, so what the
 * document shows is the stored record rather than a list row that may be a page
 * refetch behind it.
 */
function SubmissionDialog({
	submissionId,
	canEdit,
	onOpenChange,
	onChanged,
}: {
	submissionId: string | null;
	canEdit: boolean | undefined;
	onOpenChange: (open: boolean) => void;
	onChanged: () => Promise<void>;
}) {
	const detail = useQuery({
		...trpc.submittedTests.getSubmittedTest.queryOptions({
			id: submissionId ?? "",
		}),
		enabled: Boolean(submissionId),
	});

	return (
		<Dialog open={Boolean(submissionId)} onOpenChange={onOpenChange}>
			{/* Height comes from `DialogContent` itself, which bounds every dialog
			    to the viewport in `svh`. The width this document needs, and the
			    `overflow-hidden` that hands the scrolling to `DialogBody` below, are
			    what stays here: the record is longer than a screen, and a popup that
			    scrolled as a whole would take its title and close button with it. */}
			<DialogContent className="w-[min(920px,94vw)] max-w-[920px] overflow-hidden">
				<DialogHeader>
					<DialogTitle>Submitted test</DialogTitle>
					<DialogDescription>
						{canEdit
							? "Every value here can be corrected. The certifier cannot change a submitted test — you can, and the correction is recorded against your account."
							: "The full record as the certifier filed it."}
					</DialogDescription>
				</DialogHeader>

				{detail.isPending || canEdit === undefined ? (
					<DialogBody>
						<SubmissionDocumentSkeleton />
					</DialogBody>
				) : detail.isError ? (
					<DialogBody>
						<SubmissionDocumentError
							message={detail.error.message}
							onRetry={() => detail.refetch()}
						/>
					</DialogBody>
				) : (
					// Brings its own `DialogBody` and `DialogFooter`: the corrections
					// bar has to sit outside the scrolling region, and only the document
					// knows where its record ends and its actions begin.
					<SubmissionDocument
						// Remounts on target change so the fields start from the record
						// being opened rather than from whatever was open before.
						key={detail.data.id}
						submission={detail.data}
						canEdit={canEdit}
						onChanged={onChanged}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Full-width cell for the empty and error states, inside the table frame. */
function StateRow({ children }: { children: React.ReactNode }) {
	return (
		<TableRow>
			{/* whitespace-normal: the table sets nowrap for the data rows, which
			    would otherwise stop the state copy from wrapping. */}
			<TableCell colSpan={COLUMN_COUNT} className="whitespace-normal p-0">
				{children}
			</TableCell>
		</TableRow>
	);
}

function LoadingRows() {
	return Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
		<TableRow key={rowIndex}>
			{Array.from({ length: COLUMN_COUNT }, (_, cellIndex) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
				<TableCell key={cellIndex}>
					<Skeleton className="h-4 w-full rounded-sm" />
				</TableCell>
			))}
		</TableRow>
	));
}
