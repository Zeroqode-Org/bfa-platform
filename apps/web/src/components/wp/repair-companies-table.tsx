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
import { PauseCircle, Plus, TriangleAlert, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

import {
	buildRepairCompanyPayload,
	RepairCompanyForm,
	repairCompanyToFormValues,
	STATUS_LABELS,
} from "./repair-company-form";
import type { RepairCompany } from "./repair-company-types";
import { DEACTIVATION_WARNING } from "./repair-company-types";

/** Which record the form dialog is editing — or nothing, for a new one. */
type FormTarget = { mode: "create" } | { mode: "edit"; company: RepairCompany };

/**
 * What to say after a write lands. Shared by the form's save and the row's
 * status buttons, because either one can leave a company inactive and dropping
 * out of the failure notice is the part worth confirming out loud.
 */
function savedMessage(row: RepairCompany) {
	return row.status === "inactive"
		? `${row.companyName} deactivated — not in future failure notices`
		: `${row.companyName} saved`;
}

const COLUMN_COUNT = 5;
const SKELETON_ROWS = 4;

/**
 * The water purveyor's approved repair companies, and the create, edit and
 * deactivate actions on them. Repair companies never sign in — the record
 * exists so a failure notice has somewhere to send the customer.
 *
 * Both statuses are listed. This is the management table, not the notice's
 * list: a company that disappeared when it was deactivated could never be
 * corrected or brought back, and the failure workflow does its own filtering on
 * `status` at send time.
 *
 * Deactivation is the one action with a consequence past this table, so it asks
 * first and says what it does, while reactivating goes straight through —
 * putting a company back on the list is not the destructive direction. Nothing
 * here deletes: there is no delete control, no delete procedure and no DELETE
 * grant behind it.
 */
export function RepairCompaniesTable() {
	const queryClient = useQueryClient();
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.repairCompanies.listRepairCompanies.queryOptions(),
	);

	// Open state is tracked next to the target, not derived from it, so a name
	// stays on screen through the dialog's closing animation instead of blanking.
	const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);
	const [deactivateTarget, setDeactivateTarget] =
		useState<RepairCompany | null>(null);
	const [isDeactivateOpen, setIsDeactivateOpen] = useState(false);

	function invalidateList() {
		return queryClient.invalidateQueries({
			queryKey: trpc.repairCompanies.listRepairCompanies.queryKey(),
		});
	}

	const createCompany = useMutation(
		trpc.repairCompanies.createRepairCompany.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`${row.companyName} added`);
				// Refetch rather than patch the cache: the list is sorted by name, so
				// a new row's position is the server's to decide.
				await invalidateList();
				setIsFormOpen(false);
			},
			// No toast: the form shows the server's message inline, next to the
			// fields the person still has to correct.
		}),
	);

	/**
	 * The dialog form's save.
	 *
	 * Deliberately its own mutation instance rather than one shared with
	 * `setStatus` below, even though both call `updateRepairCompany`. React
	 * Query's `isPending` and `variables` belong to the instance, not to the call
	 * site, so a single shared mutation cannot tell which control started the
	 * request — and saving an edit would light up that row's Deactivate button as
	 * "Deactivating…". Two instances, two pending states, and each control
	 * reports only its own work.
	 */
	const saveCompany = useMutation(
		trpc.repairCompanies.updateRepairCompany.mutationOptions({
			onSuccess: async (row) => {
				toast.success(savedMessage(row));
				await invalidateList();
				setIsFormOpen(false);
			},
		}),
	);

	/** The row's deactivate and reactivate buttons. */
	const setStatus = useMutation(
		trpc.repairCompanies.updateRepairCompany.mutationOptions({
			onSuccess: async (row) => {
				toast.success(savedMessage(row));
				await invalidateList();
				setIsDeactivateOpen(false);
			},
			// The query cache toasts its own errors; mutations do not. This one has
			// no inline place to put a message, so it gets a toast.
			onError: (mutationError) => toast.error(mutationError.message),
		}),
	);

	/** The full record with one status flipped — the update takes every field. */
	function statusPayload(
		company: RepairCompany,
		status: RepairCompany["status"],
	) {
		return {
			id: company.id,
			...buildRepairCompanyPayload({
				...repairCompanyToFormValues(company),
				status,
			}),
		};
	}

	function openCreate() {
		createCompany.reset();
		setFormTarget({ mode: "create" });
		setIsFormOpen(true);
	}

	function openEdit(company: RepairCompany) {
		saveCompany.reset();
		setFormTarget({ mode: "edit", company });
		setIsFormOpen(true);
	}

	const isEditing = formTarget?.mode === "edit";
	const formMutation = isEditing ? saveCompany : createCompany;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-[13px] text-muted-foreground">
					{isPending || isError
						? " "
						: `${data.length} ${data.length === 1 ? "company" : "companies"}`}
				</p>
				<Button size="sm" onClick={openCreate}>
					<Plus />
					Add repair company
				</Button>
			</div>

			<div className="relative overflow-x-auto rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>Company</TableHead>
							<TableHead>Phone</TableHead>
							<TableHead>Email</TableHead>
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
										<EmptyTitle>
											Couldn&rsquo;t load repair companies
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
						) : data.length === 0 ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<Wrench />
										</EmptyMedia>
										<EmptyTitle>No repair companies yet</EmptyTitle>
										<EmptyDescription>
											Add the first one and a failure notice has somewhere to
											send the customer.
										</EmptyDescription>
									</EmptyHeader>
									<Button variant="secondary" size="sm" onClick={openCreate}>
										<Plus />
										Add repair company
									</Button>
								</Empty>
							</StateRow>
						) : (
							data.map((company) => {
								const inactive = company.status === "inactive";
								// One mutation drives every row's status button, so scope its
								// pending state to the row actually being changed. Saving an
								// edit runs through `saveCompany` and never reaches here.
								const statusPending =
									setStatus.isPending && setStatus.variables?.id === company.id;

								return (
									<TableRow key={company.id}>
										<TableCell className="font-semibold">
											{company.companyName}
										</TableCell>
										<TableCell className="text-muted-foreground tabular-nums">
											{company.phone ?? "—"}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{company.email ?? "—"}
										</TableCell>
										<TableCell>
											<div className="flex flex-col items-start gap-1">
												{inactive ? (
													<Badge variant="warning">
														<PauseCircle aria-hidden="true" />
														{STATUS_LABELS.inactive}
													</Badge>
												) : (
													<Badge variant="success">
														{STATUS_LABELS.active}
													</Badge>
												)}
												{/* Says what the status means here, rather than
												    leaving "inactive" to be interpreted. */}
												{inactive ? (
													<span className="text-[11px] text-muted-foreground">
														Not in failure notices
													</span>
												) : null}
											</div>
										</TableCell>
										<TableCell className="text-right">
											<div className="flex items-center justify-end gap-2">
												<Button
													variant="secondary"
													size="sm"
													onClick={() => openEdit(company)}
												>
													Edit
												</Button>
												<Button
													variant={inactive ? "secondary" : "destructive"}
													size="sm"
													disabled={statusPending}
													onClick={() => {
														if (inactive) {
															setStatus.mutate(
																statusPayload(company, "active"),
															);
															return;
														}
														setDeactivateTarget(company);
														setIsDeactivateOpen(true);
													}}
												>
													{statusPending
														? inactive
															? "Reactivating…"
															: "Deactivating…"
														: inactive
															? "Reactivate"
															: "Deactivate"}
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

			<Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
				<DialogContent className="max-w-[520px]">
					<DialogHeader>
						<DialogTitle>
							{isEditing ? "Edit repair company" : "Add repair company"}
						</DialogTitle>
						<DialogDescription>
							Repair companies don&rsquo;t sign in. This record is what a
							failure notice points the customer at.
						</DialogDescription>
					</DialogHeader>

					{formTarget ? (
						<RepairCompanyForm
							// Remounts on target change so the fields start from the record
							// being edited rather than from whatever was open before.
							key={isEditing ? formTarget.company.id : "create"}
							initialValues={
								isEditing
									? repairCompanyToFormValues(formTarget.company)
									: undefined
							}
							pending={formMutation.isPending}
							errorMessage={
								formMutation.isError ? formMutation.error.message : undefined
							}
							submitLabel={isEditing ? "Save changes" : "Add company"}
							pendingLabel={isEditing ? "Saving…" : "Adding…"}
							onCancel={() => setIsFormOpen(false)}
							onSubmit={(payload) => {
								if (isEditing) {
									saveCompany.mutate({
										id: formTarget.company.id,
										...payload,
									});
									return;
								}
								createCompany.mutate(payload);
							}}
						/>
					) : null}
				</DialogContent>
			</Dialog>

			<Dialog open={isDeactivateOpen} onOpenChange={setIsDeactivateOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Deactivate {deactivateTarget?.companyName}?
						</DialogTitle>
						<DialogDescription>
							{DEACTIVATION_WARNING} Nothing is deleted and notices already sent
							are unchanged — reactivating from the same button puts the company
							back on the list.
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							disabled={setStatus.isPending}
							onClick={() => {
								if (!deactivateTarget) return;
								setStatus.mutate(statusPayload(deactivateTarget, "inactive"));
							}}
						>
							{setStatus.isPending ? "Deactivating…" : "Deactivate company"}
						</Button>
					</DialogFooter>
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
