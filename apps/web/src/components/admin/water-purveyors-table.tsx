"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
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
import { Building2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useStartImpersonation } from "@/lib/use-impersonation";
import { trpc } from "@/utils/trpc";

/** The purveyor a pending block confirmation refers to. */
type BlockTarget = { id: string; companyName: string };

const countFormatter = new Intl.NumberFormat("en-US");

const COLUMN_COUNT = 7;
const SKELETON_ROWS = 4;

/**
 * Super-Admin cross-tenant list of every water purveyor, with the per-WP counts
 * from `superAdmin.listWaterPurveyors`. "Contact" is the purveyor's own WP
 * admin — the only contact the schema exposes — and falls back to an em dash
 * when there is none.
 *
 * "Impersonate" sends only the row's purveyor id to
 * `superAdmin.startImpersonation`; the server picks and validates the account,
 * sets the cookie, and the hook reloads into `/wp` as that purveyor's admin.
 */
export function WaterPurveyorsTable() {
	const startImpersonation = useStartImpersonation();
	// Busy from the click until the page is replaced — including the moment
	// after the mutation succeeds and before the navigation lands.
	const impersonationBusy =
		startImpersonation.isPending || startImpersonation.isSuccess;
	const queryClient = useQueryClient();
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.superAdmin.listWaterPurveyors.queryOptions(),
	);

	// Blocking asks first; unblocking restores access and goes straight through.
	// Open state is tracked separately from the target so the name stays on
	// screen through the dialog's closing animation instead of blanking out.
	const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
	const [isBlockDialogOpen, setIsBlockDialogOpen] = useState(false);

	const setStatus = useMutation(
		trpc.superAdmin.setWaterPurveyorStatus.mutationOptions({
			onSuccess: (row) => {
				toast.success(
					row.status === "blocked"
						? `${row.companyName} blocked`
						: `${row.companyName} unblocked`,
				);
				// The mutation already returns the updated row, so patch the cached
				// list rather than refetching it: one round trip instead of two, and
				// the value still comes from the server, so the table never shows a
				// status the database does not have. Only `status` changes here —
				// the counts are unaffected by blocking.
				queryClient.setQueryData(
					trpc.superAdmin.listWaterPurveyors.queryKey(),
					(rows) =>
						rows?.map((wp) =>
							wp.id === row.id ? { ...wp, status: row.status } : wp,
						),
				);
			},
			// The query cache toasts its own errors; mutations do not.
			onError: (mutationError) => toast.error(mutationError.message),
			onSettled: () => setIsBlockDialogOpen(false),
		}),
	);

	return (
		<>
			<div className="relative overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>Company</TableHead>
							<TableHead className="hidden min-[1180px]:table-cell">
								Contact
							</TableHead>
							<TableHead>Assets</TableHead>
							<TableHead>Certifiers</TableHead>
							<TableHead>Submissions</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isPending ? (
							<LoadingRows />
						) : isError ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<TriangleAlert className="text-danger" />
										</EmptyMedia>
										<EmptyTitle>Couldn&rsquo;t load water purveyors</EmptyTitle>
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
						) : data.length === 0 ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<Building2 />
										</EmptyMedia>
										<EmptyTitle>No water purveyors yet</EmptyTitle>
										<EmptyDescription>
											Invite the first one and it will show up here.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							</StateRow>
						) : (
							data.map((wp) => {
								const blocked = wp.status === "blocked";
								const impersonationStarting =
									impersonationBusy &&
									startImpersonation.variables?.waterPurveyorId === wp.id;
								// isPending is shared by the mutation, so scope it to the row
								// actually being changed.
								const statusPending =
									setStatus.isPending &&
									setStatus.variables?.waterPurveyorId === wp.id;

								return (
									<TableRow key={wp.id}>
										<TableCell className="font-semibold">
											{wp.companyName}
										</TableCell>
										<TableCell className="hidden text-muted-foreground min-[1180px]:table-cell">
											{wp.contact ?? "—"}
										</TableCell>
										<TableCell className="tabular-nums">
											{countFormatter.format(wp.assets)}
										</TableCell>
										<TableCell className="tabular-nums">
											{countFormatter.format(wp.certifiers)}
										</TableCell>
										<TableCell className="tabular-nums">
											{countFormatter.format(wp.submissions)}
										</TableCell>
										<TableCell>
											{wp.status === "active" ? (
												<Badge variant="success">Active</Badge>
											) : (
												<Badge variant="danger">Blocked</Badge>
											)}
										</TableCell>
										<TableCell className="text-right">
											<div className="flex items-center justify-end gap-2">
												<Button
													variant={blocked ? "secondary" : "destructive"}
													size="sm"
													disabled={statusPending}
													onClick={() => {
														if (blocked) {
															setStatus.mutate({
																waterPurveyorId: wp.id,
																status: "active",
															});
															return;
														}
														setBlockTarget({
															id: wp.id,
															companyName: wp.companyName,
														});
														setIsBlockDialogOpen(true);
													}}
												>
													{statusPending
														? blocked
															? "Unblocking…"
															: "Blocking…"
														: blocked
															? "Unblock"
															: "Block"}
												</Button>
												{/* A blocked purveyor cannot be impersonated — the server
												    refuses it too; this only saves the round trip. One
												    impersonation at a time, so every row waits on a
												    start in flight. */}
												<Button
													variant="secondary"
													size="sm"
													disabled={blocked || impersonationBusy}
													aria-busy={impersonationStarting}
													onClick={() =>
														startImpersonation.mutate({
															waterPurveyorId: wp.id,
														})
													}
												>
													{impersonationStarting ? "Starting…" : "Impersonate"}
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

			<Dialog open={isBlockDialogOpen} onOpenChange={setIsBlockDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Block {blockTarget?.companyName}?</DialogTitle>
						<DialogDescription>
							The purveyor is marked blocked across the platform. Nothing is
							deleted — its assets, certifiers and submissions stay as they are,
							and you can unblock it from the same button.
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							disabled={setStatus.isPending}
							onClick={() => {
								if (!blockTarget) return;
								setStatus.mutate({
									waterPurveyorId: blockTarget.id,
									status: "blocked",
								});
							}}
						>
							{setStatus.isPending ? "Blocking…" : "Block purveyor"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
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
				<TableCell
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
					key={cellIndex}
					className={cellIndex === 1 ? "hidden min-[1180px]:table-cell" : ""}
				>
					<Skeleton className="h-4 w-full rounded-sm" />
				</TableCell>
			))}
		</TableRow>
	));
}
