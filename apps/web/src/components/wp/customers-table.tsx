"use client";

import { isStaleCustomerError } from "@bfa-platform/api/lib/customer-revision";
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
import { PauseCircle, Plus, TriangleAlert, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

import {
	buildCustomerPayload,
	CustomerForm,
	customerFormErrors,
	customerToFormValues,
	RATE_CATEGORY_LABELS,
	STATUS_LABELS,
} from "./customer-form";
import type { Customer } from "./customer-types";
import { SUSPENSION_WARNING } from "./customer-types";

/** Which record the form dialog is editing — or nothing, for a new one. */
type FormTarget = { mode: "create" } | { mode: "edit"; customer: Customer };

/**
 * What to say after a write lands. Shared by the form's save and the row's
 * status buttons, because either one can leave a customer suspended and the
 * paused email is the part worth confirming out loud.
 */
function savedMessage(row: Customer) {
	return row.status === "suspended"
		? `${row.name} suspended — automated email paused`
		: `${row.name} saved`;
}

const COLUMN_COUNT = 6;
const SKELETON_ROWS = 4;

/**
 * The water purveyor's customer list, and the create/edit/suspend actions on
 * it. Customers never sign in, so everything about a record — including whether
 * their assets' automated email is running — is set from this screen.
 *
 * Suspension is the one action with a consequence past this table: it holds the
 * notice pipeline for every asset currently attached to the customer. So it
 * asks first and says what it does, while reactivating goes straight through —
 * restoring email is not the destructive direction.
 */
export function CustomersTable() {
	const queryClient = useQueryClient();
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.customers.listCustomers.queryOptions(),
	);

	// Open state is tracked next to the target, not derived from it, so a name
	// stays on screen through the dialog's closing animation instead of blanking.
	const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
	const [isFormOpen, setIsFormOpen] = useState(false);
	const [suspendTarget, setSuspendTarget] = useState<Customer | null>(null);
	const [isSuspendOpen, setIsSuspendOpen] = useState(false);

	function invalidateList() {
		return queryClient.invalidateQueries({
			queryKey: trpc.customers.listCustomers.queryKey(),
		});
	}

	const createCustomer = useMutation(
		trpc.customers.createCustomer.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`${row.name} added`);
				// Refetch rather than patch the cache: the list is sorted by name, so
				// a new row's position is the server's to decide.
				await invalidateList();
				setIsFormOpen(false);
			},
		}),
	);

	/**
	 * The dialog form's save.
	 *
	 * Deliberately its own mutation instance rather than one shared with
	 * `setStatus` below, even though both call `updateCustomer`. React Query's
	 * `isPending` and `variables` belong to the instance, not to the call site,
	 * so a single shared mutation cannot tell which control started the request
	 * — and saving an edit would light up that row's Suspend button as
	 * "Suspending…". Two instances, two pending states, and each control reports
	 * only its own work.
	 */
	const saveCustomer = useMutation(
		trpc.customers.updateCustomer.mutationOptions({
			onSuccess: async (row) => {
				toast.success(savedMessage(row));
				await invalidateList();
				setIsFormOpen(false);
			},
			// No toast: the form shows the server's message inline, next to the
			// fields the person still has to correct.
			onError: async (mutationError) => {
				// A stale record means the row moved on under the open form — most
				// often the AG renewal notice's annual transition. Refetch so the
				// table shows what is actually stored; the form stays open with the
				// typed values and its form-wide message, and nothing is resent
				// automatically, because the payload that failed is the out-of-date
				// one.
				if (isStaleCustomerError(mutationError)) await invalidateList();
			},
		}),
	);

	/** The row's suspend and reactivate buttons. */
	const setStatus = useMutation(
		trpc.customers.updateCustomer.mutationOptions({
			onSuccess: async (row) => {
				toast.success(savedMessage(row));
				await invalidateList();
				setIsSuspendOpen(false);
			},
			// The query cache toasts its own errors; mutations do not. This one has
			// no inline place to put a message, so it gets a toast.
			onError: async (mutationError) => {
				toast.error(mutationError.message);
				if (isStaleCustomerError(mutationError)) await invalidateList();
			},
		}),
	);

	/**
	 * The full record with one status flipped — the update takes every field,
	 * and the revision of the row this button was rendered from, so a list that
	 * has gone stale cannot suspend a customer using an old snapshot of it.
	 */
	function statusPayload(customer: Customer, status: Customer["status"]) {
		return {
			id: customer.id,
			expectedRevision: customer.revision,
			...buildCustomerPayload({ ...customerToFormValues(customer), status }),
		};
	}

	function openCreate() {
		createCustomer.reset();
		setFormTarget({ mode: "create" });
		setIsFormOpen(true);
	}

	function openEdit(customer: Customer) {
		saveCustomer.reset();
		setFormTarget({ mode: "edit", customer });
		setIsFormOpen(true);
	}

	const isEditing = formTarget?.mode === "edit";
	const formMutation = isEditing ? saveCustomer : createCustomer;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-[13px] text-muted-foreground">
					{isPending || isError
						? " "
						: `${data.length} ${data.length === 1 ? "customer" : "customers"}`}
				</p>
				<Button size="sm" onClick={openCreate}>
					<Plus />
					Add customer
				</Button>
			</div>

			<div className="relative overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Account number</TableHead>
							<TableHead>Email</TableHead>
							<TableHead>Rate category</TableHead>
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
										<EmptyTitle>Couldn&rsquo;t load customers</EmptyTitle>
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
											<Users />
										</EmptyMedia>
										<EmptyTitle>No customers yet</EmptyTitle>
										<EmptyDescription>
											Add the first one and their assets&rsquo; automated email
											has somewhere to go.
										</EmptyDescription>
									</EmptyHeader>
									<Button variant="secondary" size="sm" onClick={openCreate}>
										<Plus />
										Add customer
									</Button>
								</Empty>
							</StateRow>
						) : (
							data.map((customer) => {
								const suspended = customer.status === "suspended";
								// One mutation drives every row's status button, so scope its
								// pending state to the row actually being changed. Saving an
								// edit runs through `saveCustomer` and never reaches here.
								const statusPending =
									setStatus.isPending &&
									setStatus.variables?.id === customer.id;

								return (
									<TableRow key={customer.id}>
										<TableCell className="font-semibold">
											{customer.name}
										</TableCell>
										<TableCell className="text-muted-foreground tabular-nums">
											{customer.accountNumber ?? "—"}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{customer.email}
										</TableCell>
										<TableCell>
											{customer.rateCategory === "agricultural" ? (
												<Badge variant="purple">
													{RATE_CATEGORY_LABELS.agricultural}
												</Badge>
											) : (
												<Badge variant="neutral">
													{RATE_CATEGORY_LABELS.standard}
												</Badge>
											)}
										</TableCell>
										<TableCell>
											<div className="flex flex-col items-start gap-1">
												{suspended ? (
													<Badge variant="warning">
														<PauseCircle aria-hidden="true" />
														{STATUS_LABELS.suspended}
													</Badge>
												) : (
													<Badge variant="success">
														{STATUS_LABELS.active}
													</Badge>
												)}
												{/* Says what the status means here, rather than
												    leaving "suspended" to be interpreted. */}
												{suspended ? (
													<span className="text-[11px] text-muted-foreground">
														Automated email paused
													</span>
												) : null}
											</div>
										</TableCell>
										<TableCell className="text-right">
											<div className="flex items-center justify-end gap-2">
												<Button
													variant="secondary"
													size="sm"
													onClick={() => openEdit(customer)}
												>
													Edit
												</Button>
												<Button
													variant={suspended ? "secondary" : "destructive"}
													size="sm"
													disabled={statusPending}
													onClick={() => {
														if (suspended) {
															setStatus.mutate(
																statusPayload(customer, "active"),
															);
															return;
														}
														setSuspendTarget(customer);
														setIsSuspendOpen(true);
													}}
												>
													{statusPending
														? suspended
															? "Reactivating…"
															: "Suspending…"
														: suspended
															? "Reactivate"
															: "Suspend"}
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
				{/* overflow-hidden: the form inside pins its own footer and scrolls
				    its fields, so the popup must clip rather than scroll — two scroll
				    containers would put the footer back out of reach. */}
				<DialogContent className="max-w-[520px] overflow-hidden">
					<DialogHeader>
						<DialogTitle>
							{isEditing ? "Edit customer" : "Add customer"}
						</DialogTitle>
						<DialogDescription>
							Customers don&rsquo;t sign in. This record is what their
							assets&rsquo; automated email is addressed to.
						</DialogDescription>
					</DialogHeader>

					{formTarget ? (
						<CustomerForm
							// Remounts on target change so the fields start from the record
							// being edited rather than from whatever was open before.
							key={isEditing ? formTarget.customer.id : "create"}
							initialValues={
								isEditing
									? customerToFormValues(formTarget.customer)
									: undefined
							}
							pending={formMutation.isPending}
							// A duplicate email goes under the Email field; anything else
							// is the form-wide message. Never a toast.
							{...customerFormErrors(
								formMutation.isError ? formMutation.error : null,
							)}
							submitLabel={isEditing ? "Save changes" : "Add customer"}
							pendingLabel={isEditing ? "Saving…" : "Adding…"}
							onCancel={() => setIsFormOpen(false)}
							onSubmit={(payload) => {
								if (isEditing) {
									saveCustomer.mutate({
										id: formTarget.customer.id,
										// The version this form was opened with, not whatever the
										// list holds now: that is the whole point of the check.
										expectedRevision: formTarget.customer.revision,
										...payload,
									});
									return;
								}
								createCustomer.mutate(payload);
							}}
						/>
					) : null}
				</DialogContent>
			</Dialog>

			<Dialog open={isSuspendOpen} onOpenChange={setIsSuspendOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Suspend {suspendTarget?.name}?</DialogTitle>
						<DialogDescription>
							{SUSPENSION_WARNING} Nothing is deleted, and their assets keep
							their assignments — reactivating from the same button starts the
							email again.
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							disabled={setStatus.isPending}
							onClick={() => {
								if (!suspendTarget) return;
								setStatus.mutate(statusPayload(suspendTarget, "suspended"));
							}}
						>
							{setStatus.isPending ? "Suspending…" : "Suspend customer"}
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
