"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button, buttonVariants } from "@bfa-platform/ui/components/button";
import {
	Dialog,
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
import { Input } from "@bfa-platform/ui/components/input";
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
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { ClipboardList, Plus, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

import { AddAssetForm, EditAssetForm } from "./asset-form";
import type { Asset, AssetStatus } from "./asset-types";
import {
	ASSET_STATUS_LABELS,
	ASSET_STATUS_VARIANTS,
	assetFormErrors,
	formatAssetDate,
} from "./asset-types";

/** Which record the form dialog is editing — or nothing, for a new one. */
type FormTarget = { mode: "create" } | { mode: "edit"; asset: Asset };

/** The status filter, with the unfiltered case as a value rather than absence. */
const STATUS_FILTERS = {
	all: "All statuses",
	active: ASSET_STATUS_LABELS.active,
	due_soon: ASSET_STATUS_LABELS.due_soon,
	past_due: ASSET_STATUS_LABELS.past_due,
} as const;

type StatusFilter = keyof typeof STATUS_FILTERS;

const COLUMN_COUNT = 7;
const SKELETON_ROWS = 6;
const PAGE_SIZE = 25;
/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The water purveyor's BFA asset list: the physical valves it is responsible
 * for, and the create/edit actions on them.
 *
 * A WP registers an asset here directly, with no certifier submission behind it
 * (PRD § 7, flow 3), and the annual test date entered on the form is what the
 * reminder workflow schedules against. Two things the table shows are *not*
 * editable from it — the status, which the scheduler computes from that date,
 * and the current customer, which is attached from the asset's own page so the
 * change is recorded as occupancy rather than as an edit.
 */
export function AssetsTable() {
	const queryClient = useQueryClient();

	const [page, setPage] = useState(1);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [search, setSearch] = useState("");
	// What the query actually asks for. Separated from what is in the box so a
	// typed word is one request rather than one per keystroke.
	const [appliedSearch, setAppliedSearch] = useState("");

	useEffect(() => {
		const timer = setTimeout(() => {
			setAppliedSearch(search.trim());
		}, SEARCH_DEBOUNCE_MS);

		return () => clearTimeout(timer);
	}, [search]);

	// A narrowed list is a different list: staying on page 4 of it would show an
	// empty page and read as "no matches".
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the pager when the filters change, not when the page does
	useEffect(() => {
		setPage(1);
	}, [appliedSearch, status]);

	const listInput = {
		page,
		pageSize: PAGE_SIZE,
		status: status === "all" ? undefined : (status as AssetStatus),
		search: appliedSearch || undefined,
	};

	const { data, isPending, isError, error, refetch, isPlaceholderData } =
		useQuery(
			trpc.assets.listAssets.queryOptions(listInput, {
				// Keeps the previous page on screen while the next one loads, so
				// paging does not blink the whole table back to skeletons.
				placeholderData: keepPreviousData,
			}),
		);

	// Open state is tracked next to the target, not derived from it, so a BIN
	// stays on screen through the dialog's closing animation instead of blanking.
	const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);

	// The add form's optional customer picker. WP-scoped, the same list the
	// customers screen reads, so there is no other tenant's customer to offer —
	// and fetched only once the dialog is open, because most visits to this page
	// never open it.
	const customers = useQuery(
		trpc.customers.listCustomers.queryOptions(undefined, {
			enabled: isFormOpen,
		}),
	);

	function invalidateList() {
		return queryClient.invalidateQueries({
			queryKey: trpc.assets.listAssets.queryKey(),
		});
	}

	const createAsset = useMutation(
		trpc.assets.createAsset.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`${row.bin} registered`);
				// Refetch rather than patch the cache: the list is sorted and paged,
				// so a new row's position is the server's to decide.
				await invalidateList();
				setIsFormOpen(false);
			},
			// No toast on failure: the form shows the server's message inline, next
			// to the BIN the person still has to change.
		}),
	);

	const saveAsset = useMutation(
		trpc.assets.updateAsset.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`${row.bin} saved`);
				await invalidateList();
				await queryClient.invalidateQueries({
					queryKey: trpc.assets.getAsset.queryKey({ id: row.id }),
				});
				setIsFormOpen(false);
			},
		}),
	);

	function openCreate() {
		createAsset.reset();
		setFormTarget({ mode: "create" });
		setIsFormOpen(true);
	}

	function openEdit(asset: Asset) {
		saveAsset.reset();
		setFormTarget({ mode: "edit", asset });
		setIsFormOpen(true);
	}

	const isEditing = formTarget?.mode === "edit";
	const formMutation = isEditing ? saveAsset : createAsset;
	const total = data?.total ?? 0;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative">
						<Search
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-tertiary"
							aria-hidden="true"
						/>
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search BIN or service address"
							aria-label="Search assets by BIN or service address"
							type="search"
							autoComplete="off"
							className="w-[260px] pl-8"
						/>
					</div>

					<Select
						items={STATUS_FILTERS}
						value={status}
						onValueChange={(value) => setStatus(value as StatusFilter)}
					>
						<SelectTrigger aria-label="Filter by status" className="w-[160px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{Object.entries(STATUS_FILTERS).map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>

				<Button size="sm" onClick={openCreate}>
					<Plus />
					Add asset
				</Button>
			</div>

			<div className="relative overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>BIN</TableHead>
							<TableHead>BFA type</TableHead>
							<TableHead>Service address</TableHead>
							<TableHead>Current customer</TableHead>
							<TableHead>Annual test date</TableHead>
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
										<EmptyTitle>Couldn&rsquo;t load assets</EmptyTitle>
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
											<ClipboardList />
										</EmptyMedia>
										{/* Two different nothings: a purveyor with no assets yet
										    needs the Add button; a search with no hits needs to
										    know the filter is what emptied the table. */}
										<EmptyTitle>
											{appliedSearch || status !== "all"
												? "No assets match these filters"
												: "No assets yet"}
										</EmptyTitle>
										<EmptyDescription>
											{appliedSearch || status !== "all"
												? "Try a different BIN, address or status."
												: "Register the first valve and its annual test date puts it on the reminder schedule."}
										</EmptyDescription>
									</EmptyHeader>
									{appliedSearch || status !== "all" ? (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => {
												setSearch("");
												setStatus("all");
											}}
										>
											Clear filters
										</Button>
									) : (
										<Button variant="secondary" size="sm" onClick={openCreate}>
											<Plus />
											Add asset
										</Button>
									)}
								</Empty>
							</StateRow>
						) : (
							data.rows.map((asset) => (
								<TableRow key={asset.id}>
									<TableCell className="font-semibold">
										<Link
											href={`/wp/assets/${asset.id}`}
											className="text-primary hover:underline"
										>
											{asset.bin}
										</Link>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{asset.bfaType}
									</TableCell>
									<TableCell>{asset.serviceAddress}</TableCell>
									<TableCell>
										{asset.currentCustomerName ? (
											<div className="flex flex-col items-start gap-1">
												<span>{asset.currentCustomerName}</span>
												{/* A suspended occupant stops this asset's email
												    entirely, so the asset says so rather than
												    leaving it to be found on the customer screen. */}
												{asset.currentCustomerStatus === "suspended" ? (
													<span className="text-[11px] text-warning">
														Suspended — email paused
													</span>
												) : null}
											</div>
										) : (
											<span className="text-muted-foreground">Unassigned</span>
										)}
									</TableCell>
									<TableCell className="tabular-nums">
										{formatAssetDate(asset.annualTestDate)}
									</TableCell>
									<TableCell>
										<Badge variant={ASSET_STATUS_VARIANTS[asset.assetStatus]}>
											{ASSET_STATUS_LABELS[asset.assetStatus]}
										</Badge>
									</TableCell>
									<TableCell className="text-right">
										<div className="flex items-center justify-end gap-2">
											<Button
												variant="secondary"
												size="sm"
												onClick={() => openEdit(asset)}
											>
												Edit
											</Button>
											{/* A link wearing a button's styling — the class
											    names are borrowed and the element is left alone.

											    Not `<Button render={<Link/>}>`: Base UI's Button
											    assumes it renders a native <button>, and the
											    `nativeButton={false}` escape hatch silences its
											    warning by shimming the anchor *into* a button —
											    it stamps `role="button"` on it. This control
											    navigates, so it should announce as a link and
											    keep middle-click and open-in-new-tab. */}
											<Link
												href={`/wp/assets/${asset.id}`}
												className={buttonVariants({
													variant: "ghost",
													size: "sm",
												})}
											>
												View
											</Link>
										</div>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-[13px] text-muted-foreground">
					{isPending || isError
						? " "
						: `${total} ${total === 1 ? "asset" : "assets"}`}
				</p>

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

			<Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
				<DialogContent className="max-w-[560px]">
					<DialogHeader>
						<DialogTitle>{isEditing ? "Edit asset" : "Add asset"}</DialogTitle>
						<DialogDescription>
							{isEditing
								? "Every field can be corrected, the BIN included — a BIN change is recorded with both values."
								: "Registering an assembly here needs no certifier submission. Its annual test date starts the reminder schedule."}
						</DialogDescription>
					</DialogHeader>

					{formTarget ? (
						isEditing ? (
							<EditAssetForm
								// Remounts on target change so the fields start from the
								// record being edited rather than from whatever was open
								// before.
								key={formTarget.asset.id}
								asset={formTarget.asset}
								pending={formMutation.isPending}
								{...assetFormErrors(
									formMutation.isError ? formMutation.error : null,
								)}
								onCancel={() => setIsFormOpen(false)}
								onSubmit={(payload) =>
									saveAsset.mutate({ id: formTarget.asset.id, ...payload })
								}
							/>
						) : (
							<AddAssetForm
								key="create"
								pending={formMutation.isPending}
								customerOptions={customers.data ?? []}
								customersPending={customers.isPending}
								{...assetFormErrors(
									formMutation.isError ? formMutation.error : null,
								)}
								onCancel={() => setIsFormOpen(false)}
								onSubmit={(payload) => createAsset.mutate(payload)}
							/>
						)
					) : null}
				</DialogContent>
			</Dialog>
		</div>
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
