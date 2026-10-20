"use client";

import {
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	PHOTO_PATH_KEYS,
} from "@bfa-platform/api/lib/wizard-input";
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
	TEST_RESULT_LABELS,
	TEST_RESULT_VARIANTS,
	WIDE_COLUMN,
	wizardEntries,
} from "./certifier-types";
import { TestDocument } from "./test-document";
import { usePhotoUrls } from "./wizard/use-photo-urls";
import type { WizardValues } from "./wizard/wizard-types";

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
			<div className="@container overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>BIN</TableHead>
							{/* `w-*` on a short-content column: under the default
							    `table-layout: auto`, a one-word column otherwise hugs its
							    header text and sits flush against its neighbor. On a narrow
							    card Type and Test date fold under the BIN (`WIDE_COLUMN`);
							    Result keeps its column, so a pass or fail reads at a glance. */}
							<TableHead className={`${WIDE_COLUMN} w-36`}>Type</TableHead>
							<TableHead className={`${WIDE_COLUMN} w-32`}>Test date</TableHead>
							<TableHead className="@2xl:w-28">Result</TableHead>
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
											<div className="flex flex-col items-start gap-1">
												<button
													type="button"
													onClick={() => setOpenId(submission.id)}
													className="text-primary hover:underline"
												>
													{bin.text}
												</button>
												<span className="@2xl:hidden whitespace-normal font-normal text-[12px] text-muted-foreground tabular-nums">
													{submission.bfaType} ·{" "}
													{formatTestDate(submission.testDate)}
												</span>
											</div>
										</TableCell>
										<TableCell
											className={`${WIDE_COLUMN} text-muted-foreground`}
										>
											{submission.bfaType}
										</TableCell>
										<TableCell className={`${WIDE_COLUMN} tabular-nums`}>
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
 * Read-only document for one of the certifier's own submitted tests, laid out
 * as the test form itself — the same `TestDocument` the wizard's review screen
 * draws, which follows the results PDF section by section — so a test looks
 * the same before submit, in the archive and on paper.
 *
 * Opens on the list row's own data at once; the sign-off (the one large
 * column, left off the list rows) arrives with `certifier.getSubmission`.
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
	const { active } = useActiveWp();
	const detail = useQuery({
		...trpc.certifier.getSubmission.queryOptions({
			id: submission?.id ?? "",
			waterPurveyorId: active?.id ?? "",
		}),
		enabled: open && Boolean(submission && active),
	});
	const profile = useQuery(trpc.certifier.getProfile.queryOptions());
	const wizardData = Object.fromEntries(
		wizardEntries(submission?.wizardData),
	) as WizardValues;
	const photoPaths = PHOTO_PATH_KEYS.flatMap((key) => {
		const path = wizardData[key];

		return typeof path === "string" && path ? [path] : [];
	});
	const photoUrls = usePhotoUrls(
		active ? submission?.id : undefined,
		active?.id ?? "",
		photoPaths,
	);
	const getDocumentUrl = useMutation(
		trpc.certifierWizard.getResultDocumentUrl.mutationOptions(),
	);
	const text = (value: unknown) => (typeof value === "string" ? value : "");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[min(760px,94vw)] max-w-[760px] overflow-hidden">
				{/* The download sits in the pinned header, not after the record: a
				    long test should not need scrolling to the end to get its PDF.
				    `pr-8` keeps it clear of the close button. */}
				<DialogHeader className="flex-row flex-wrap items-start justify-between gap-3 pr-8">
					<div className="flex min-w-0 flex-col gap-1">
						<DialogTitle>Submitted test</DialogTitle>
						{submission ? (
							<div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
								<span className="font-semibold text-foreground">
									{binLabel(submission).text}
								</span>
								<span aria-hidden="true">·</span>
								<span>Tested {formatTestDate(submission.testDate)}</span>
								{submission.testResult ? (
									<Badge variant={TEST_RESULT_VARIANTS[submission.testResult]}>
										{TEST_RESULT_LABELS[submission.testResult]}
									</Badge>
								) : null}
							</div>
						) : null}
					</div>
					{submission && active ? (
						<ResultDocumentButton
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
				</DialogHeader>
				<DialogBody className="flex flex-col gap-4">
					{submission && active ? (
						<>
							<TestDocument
								// The dialog's own header already names the test; only the
								// form's blocks go under it.
								variant="sections"
								bfaType={submission.bfaType}
								bin={binLabel(submission).text}
								wizardData={wizardData}
								customerName={text(wizardData[CUSTOMER_NAME_KEY])}
								customerEmail={text(wizardData[CUSTOMER_EMAIL_KEY])}
								testDate={submission.testDate}
								signatureMethod={detail.data?.signatureMethod ?? null}
								signatureData={detail.data?.signatureData ?? null}
								photoPaths={photoPaths}
								photoUrls={photoUrls}
								certifier={profile.data ?? null}
								unsignedLabel={detail.isPending ? "Loading…" : "Not signed."}
							/>

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
				<TableCell
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
					key={cellIndex}
					className={
						cellIndex === 1 || cellIndex === 2 ? WIDE_COLUMN : undefined
					}
				>
					<Skeleton className="h-4 w-full rounded-sm" />
				</TableCell>
			))}
		</TableRow>
	));
}
