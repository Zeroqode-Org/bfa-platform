"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
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
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@bfa-platform/ui/components/table";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ResultDocumentButton } from "@/components/result-document-button";
import { useActiveWp } from "@/lib/use-active-wp";
import { trpc } from "@/utils/trpc";

import type { CertifierSubmissionRow } from "./certifier-types";
import {
	binLabel,
	formatTestDate,
	humanizeFieldName,
	TEST_RESULT_LABELS,
	TEST_RESULT_VARIANTS,
	wizardEntries,
	wizardValueText,
} from "./certifier-types";

const COLUMN_COUNT = 5;
const SKELETON_ROWS = 4;

/**
 * The certifier's own submitted archive, newest test first.
 *
 * A row opens a read-only document. There is no edit affordance anywhere on
 * this screen, not even conditionally — a submitted test is locked for the
 * certifier who filed it the moment it submits (PRD § 8); only the water
 * purveyor who received it may correct one, on their own screen.
 */
export function SubmissionsTable({
	initialSubmissionId,
}: {
	initialSubmissionId?: string;
} = {}) {
	const { active, isLoading: isWpLoading, isError: isWpError } = useActiveWp();
	const [page, setPage] = useState(1);
	const [openId, setOpenId] = useState<string | null>(
		initialSubmissionId ?? null,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the pager when the active WP changes, not when the page does
	useEffect(() => {
		setPage(1);
	}, [active?.id]);

	const { data, isPending, isError, error, refetch } = useQuery({
		...trpc.certifier.listSubmissions.queryOptions({
			page,
			pageSize: 25,
			waterPurveyorId: active?.id ?? "",
		}),
		enabled: Boolean(active),
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>BIN</TableHead>
							{/* `w-*` on a short-content column: under the default
							    `table-layout: auto`, a one-word column otherwise hugs its
							    header text and sits flush against its neighbor. */}
							<TableHead className="w-36">Type</TableHead>
							<TableHead className="w-32">Test date</TableHead>
							<TableHead className="w-28">Result</TableHead>
							<TableHead>
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isWpLoading ? (
							<LoadingRows />
						) : isWpError ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<TriangleAlert className="text-danger" />
										</EmptyMedia>
										<EmptyTitle>
											Couldn&rsquo;t load your water purveyors
										</EmptyTitle>
									</EmptyHeader>
								</Empty>
							</StateRow>
						) : !active ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<FileText />
										</EmptyMedia>
										<EmptyTitle>
											Not authorized for any water purveyor
										</EmptyTitle>
										<EmptyDescription>
											Submitted tests will appear here once a purveyor
											authorizes you to work for them.
										</EmptyDescription>
									</EmptyHeader>
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
										<EmptyTitle>
											Couldn&rsquo;t load your submitted tests
										</EmptyTitle>
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
										<EmptyTitle>No submitted tests yet</EmptyTitle>
										<EmptyDescription>
											Tests you submit from the wizard appear here.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							</StateRow>
						) : (
							data.rows.map((submission) => {
								const bin = binLabel(submission);
								return (
									<TableRow key={submission.id}>
										<TableCell className="font-semibold">
											<button
												type="button"
												onClick={() => setOpenId(submission.id)}
												className="text-primary hover:underline"
											>
												{bin.text}
											</button>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{submission.bfaType}
										</TableCell>
										<TableCell className="tabular-nums">
											{formatTestDate(submission.testDate)}
										</TableCell>
										<TableCell>
											{submission.testResult ? (
												<Badge
													variant={TEST_RESULT_VARIANTS[submission.testResult]}
												>
													{TEST_RESULT_LABELS[submission.testResult]}
												</Badge>
											) : (
												<span className="text-muted-foreground">—</span>
											)}
										</TableCell>
										<TableCell className="text-right">
											<Button
												variant="secondary"
												size="sm"
												onClick={() => setOpenId(submission.id)}
											>
												Open
											</Button>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</div>

			{data && data.pageCount > 1 ? (
				<div className="flex items-center justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						disabled={page <= 1}
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
						disabled={page >= data.pageCount}
						onClick={() => setPage((current) => current + 1)}
					>
						Next
					</Button>
				</div>
			) : null}

			<SubmissionDetailDialog
				submission={data?.rows.find((row) => row.id === openId)}
				open={Boolean(openId)}
				onOpenChange={(open) => {
					if (!open) setOpenId(null);
				}}
			/>
		</div>
	);
}

/**
 * Read-only document for one of the certifier's own submitted tests.
 *
 * Found in the already-loaded page rather than fetched again — every column
 * this dialog shows, `wizardData` included, is already on the list row (see
 * `certifierRowSelection` on the server), and this router has no dedicated
 * single-submission read to fetch it with a second time.
 */
function SubmissionDetailDialog({
	submission,
	open,
	onOpenChange,
}: {
	submission: CertifierSubmissionRow | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const entries = submission ? wizardEntries(submission.wizardData) : [];
	const { active } = useActiveWp();
	const getDocumentUrl = useMutation(
		trpc.certifierWizard.getResultDocumentUrl.mutationOptions(),
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[min(640px,94vw)] max-w-[640px] overflow-hidden">
				<DialogHeader>
					<DialogTitle>Submitted test</DialogTitle>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-4">
					{submission ? (
						<>
							<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
								<Field label="BIN" value={binLabel(submission).text} />
								<Field label="Type" value={submission.bfaType} />
								<Field
									label="Test date"
									value={formatTestDate(submission.testDate)}
								/>
								<Field
									label="Result"
									value={
										submission.testResult
											? TEST_RESULT_LABELS[submission.testResult]
											: "—"
									}
								/>
							</dl>

							{entries.length > 0 ? (
								<dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-border-soft border-t pt-4 text-[13px]">
									{entries.map(([key, value]) => (
										<Field
											key={key}
											label={humanizeFieldName(key)}
											value={wizardValueText(value)}
										/>
									))}
								</dl>
							) : null}

							{active ? (
								<ResultDocumentButton
									className="self-start"
									fetchUrl={async () =>
										(
											await getDocumentUrl.mutateAsync({
												id: submission.id,
												waterPurveyorId: active.id,
											})
										).url
									}
								/>
							) : null}

							<p className="text-[12px] text-muted-foreground">
								This record is locked. Only the water purveyor it was filed to
								can correct it.
							</p>
						</>
					) : (
						<p className="text-[13px] text-muted-foreground">
							Open this record from the table to see it here.
						</p>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-[11px] text-muted-foreground">{label}</dt>
			<dd className="font-medium text-foreground">{value}</dd>
		</div>
	);
}

function StateRow({ children }: { children: React.ReactNode }) {
	return (
		<TableRow>
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
