"use client";

import { Button, buttonVariants } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useActiveWp } from "@/lib/use-active-wp";
import { trpc } from "@/utils/trpc";
import type { CertifierSubmissionRow } from "./certifier-types";
import { binLabel, formatSavedAt } from "./certifier-types";

const COLUMN_COUNT = 5;
const SKELETON_ROWS = 4;

/**
 * The certifier's own drafts, most recently saved first.
 *
 * Every row is this certifier's own working copy — `certifier.listDrafts`
 * scopes by `certifier_id`, so there is no filter to build here the way the
 * WP submitted-tests screen needs one; a certifier's own draft list is short
 * enough that a single unpaginated page is the common case, and the pager
 * only appears once it isn't.
 */
export function DraftsTable() {
	const queryClient = useQueryClient();
	const { active, isLoading: isWpLoading, isError: isWpError } = useActiveWp();
	const [page, setPage] = useState(1);
	const [deleteTarget, setDeleteTarget] =
		useState<CertifierSubmissionRow | null>(null);

	// A page number from a longer list under a different WP can point past
	// the new one's — switching WPs re-filters the whole list (§ 6.4), so it
	// re-starts at the first page rather than showing an empty one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the pager when the active WP changes, not when the page does
	useEffect(() => {
		setPage(1);
	}, [active?.id]);

	const { data, isPending, isError, error, refetch } = useQuery({
		...trpc.certifier.listDrafts.queryOptions({
			page,
			pageSize: 25,
			waterPurveyorId: active?.id ?? "",
		}),
		enabled: Boolean(active),
	});

	const deleteDraft = useMutation(
		trpc.certifier.deleteDraft.mutationOptions({
			onSuccess: async () => {
				toast.success("Draft deleted");
				setDeleteTarget(null);
				await queryClient.invalidateQueries({
					queryKey: trpc.certifier.listDrafts.queryKey(),
				});
			},
			onError: (mutationError) => {
				// A draft already gone — deleted elsewhere, or submitted through the
				// wizard in another tab — is not an error worth alarming over. The
				// list simply no longer has the row once this refetches.
				if (mutationError.data?.code === "NOT_FOUND") {
					toast("That draft is no longer available");
					setDeleteTarget(null);
					queryClient.invalidateQueries({
						queryKey: trpc.certifier.listDrafts.queryKey(),
					});
					return;
				}
				toast.error(mutationError.message);
			},
		}),
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>BIN</TableHead>
							{/* `table-layout: auto` (the default) sizes a column to its
							    widest content, so a one-word/one-digit column like Type
							    or Step would otherwise hug its header text and sit flush
							    against its neighbor. A `w-*` on the header is a minimum
							    the browser still honors under auto layout, giving each
							    column room instead of collapsing to its content. */}
							<TableHead className="w-36">Type</TableHead>
							<TableHead className="w-24">Step</TableHead>
							<TableHead>Last saved</TableHead>
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
											You&rsquo;ll see drafts here once a purveyor authorizes
											you to work for them.
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
										<EmptyTitle>Couldn&rsquo;t load your drafts</EmptyTitle>
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
										<EmptyTitle>No drafts</EmptyTitle>
										<EmptyDescription>
											Start a new test from the Wizard tab — it saves here at
											every step.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							</StateRow>
						) : (
							data.rows.map((draft) => {
								const bin = binLabel(draft);
								return (
									<TableRow key={draft.id}>
										<TableCell className="font-semibold">
											<div className="flex flex-col items-start gap-1">
												<span>{bin.text}</span>
												{bin.resolved ? null : (
													<span className="font-normal text-[11px] text-warning">
														Not linked to an asset
													</span>
												)}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{draft.bfaType}
										</TableCell>
										<TableCell className="text-muted-foreground tabular-nums">
											{draft.currentStep ?? "—"}
										</TableCell>
										<TableCell className="text-muted-foreground tabular-nums">
											{formatSavedAt(draft.updatedAt)}
										</TableCell>
										<TableCell className="text-right">
											<div className="flex justify-end gap-2">
												{/* A link wearing a button's styling, not
												    `<Button render={<Link/>}>` — see assets-table.tsx
												    for why: this control navigates, so it should
												    announce as a link and keep middle-click. */}
												<Link
													href={`/certifier/wizard?draftId=${draft.id}`}
													className={buttonVariants({
														variant: "secondary",
														size: "sm",
													})}
												>
													Resume
												</Link>
												<Button
													variant="destructive"
													size="sm"
													aria-label={`Delete draft ${bin.text}`}
													onClick={() => setDeleteTarget(draft)}
												>
													Delete
												</Button>
											</div>
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

			<Dialog
				open={Boolean(deleteTarget)}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete this draft?</DialogTitle>
						<DialogDescription>
							{deleteTarget ? binLabel(deleteTarget).text : "This draft"} will
							be gone for good — there is no undo. Nothing has been submitted,
							so nothing else is affected.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							disabled={deleteDraft.isPending}
							onClick={() => {
								if (!deleteTarget || !active) return;
								deleteDraft.mutate({
									id: deleteTarget.id,
									waterPurveyorId: active.id,
								});
							}}
						>
							{deleteDraft.isPending ? "Deleting…" : "Delete draft"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
