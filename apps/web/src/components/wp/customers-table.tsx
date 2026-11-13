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
import { PauseCircle, Plus, TriangleAlert, Unlink, Users } from "lucide-react";
import { useMemo, useState } from "react";
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

/** One asset a customer currently holds, as `listCustomers` returns it. */
type HeldAsset = Customer["assets"][number];

/**
 * One line of the table: a customer and one asset they hold — or, for a
 * customer holding nothing, the customer alone. The client asked for a line
 * per BIN so each one can be managed — de-linked — on its own.
 */
type CustomerRow = { customer: Customer; asset: HeldAsset | null };

/** The asset a De-link confirmation is about, and whose link it ends. */
type DelinkTarget = { customer: Customer; asset: HeldAsset };

/**
 * A line per (customer, asset), keeping the server's order: customers A–Z,
 * each one's assets by BIN. A customer holding nothing still gets a line, so
 * the record stays reachable and its missing BIN stays visible.
 */
function customerRows(customers: Customer[]): CustomerRow[] {
	return customers.flatMap<CustomerRow>((customer) =>
		customer.assets.length > 0
			? customer.assets.map((asset) => ({ customer, asset }))
			: [{ customer, asset: null }],
	);
}

/** How a held asset's BIN reads in a row, sentence or toast. */
function binLabel(asset: HeldAsset) {
	return asset.bin ?? "No BIN";
}

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

const COLUMN_COUNT = 7;
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
	const [delinkTarget, setDelinkTarget] = useState<DelinkTarget | null>(null);
	const [isDelinkOpen, setIsDelinkOpen] = useState(false);

	const rows = useMemo(() => (data ? customerRows(data) : []), [data]);

	async function invalidateList() {
		await queryClient.invalidateQueries({
			queryKey: trpc.customers.listCustomers.queryKey(),
		});
		// A save can attach a BIN, which moves an asset's current customer — so
		// the assets screens' cached rows and detail pages are stale too.
		await queryClient.invalidateQueries({
			queryKey: trpc.assets.pathKey(),
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
	 * The row's De-link. Ends this customer's link to this one asset, so its
	 * automated email stops going to them; the asset reads as Unassigned until
	 * somebody else is attached.
	 */
	const delinkCustomer = useMutation(
		trpc.assets.delinkCustomer.mutationOptions({
			// Named from the request that finished, not from whichever line the
			// dialog shows now.
			onSuccess: async (_asset, { assetId, customerId }) => {
				const done = rows.find(
					(row) => row.customer.id === customerId && row.asset?.id === assetId,
				);

				if (done?.asset) {
					toast.success(
						`${binLabel(done.asset)} de-linked from ${done.customer.name}`,
					);
				}
				await invalidateList();
				setIsDelinkOpen(false);
			},
			// A refusal here is usually the BIN having moved since the list was
			// loaded, so the list is refetched to show who holds it now.
			onError: async (mutationError) => {
				toast.error(mutationError.message);
				setIsDelinkOpen(false);
				await invalidateList();
			},
		}),
	);

	function openDelink(customer: Customer, asset: HeldAsset) {
		// One De-link at a time: the dialog stays on the request it sent until
		// that request answers.
		if (delinkCustomer.isPending) return;
		delinkCustomer.reset();
		setDelinkTarget({ customer, asset });
		setIsDelinkOpen(true);
	}

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
					{isPending || isError ? " " : listSummary(data, rows)}
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
							<TableHead>BIN</TableHead>
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
							rows.map(({ customer, asset }) => {
								const suspended = customer.status === "suspended";
								// One mutation drives every row's status button, so scope its
								// pending state to the row actually being changed. Saving an
								// edit runs through `saveCustomer` and never reaches here.
								const statusPending =
									setStatus.isPending &&
									setStatus.variables?.id === customer.id;

								return (
									<TableRow key={`${customer.id}:${asset?.id ?? "none"}`}>
										<TableCell className="font-semibold">
											{customer.name}
										</TableCell>
										{/* A customer holding nothing gets no test
										    reminders, so the gap is named ("No asset")
										    rather than left as a dash — in a neutral badge,
										    since the BIN is optional and this is a normal
										    state. A held asset without a BIN is attached, so
										    it reads plainly as "No BIN". */}
										<TableCell className="tabular-nums">
											{asset ? (
												asset.bin === null ? (
													<span className="text-muted-foreground">No BIN</span>
												) : (
													asset.bin
												)
											) : (
												<Badge variant="neutral">No asset</Badge>
											)}
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
												{asset ? (
													<Button
														variant="secondary"
														size="sm"
														aria-label={`De-link ${binLabel(asset)} from ${customer.name}`}
														disabled={delinkCustomer.isPending}
														onClick={() => openDelink(customer, asset)}
													>
														<Unlink aria-hidden="true" />
														De-link
													</Button>
												) : null}
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
							heldBins={isEditing ? formTarget.customer.bins : []}
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

			<Dialog
				open={isDelinkOpen}
				onOpenChange={(open) => {
					if (!open && delinkCustomer.isPending) return;
					setIsDelinkOpen(open);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							De-link {delinkTarget ? binLabel(delinkTarget.asset) : ""} from{" "}
							{delinkTarget?.customer.name}?
						</DialogTitle>
						<DialogDescription>
							Use this when the asset has changed hands.{" "}
							{delinkTarget?.customer.name} stops receiving automated email
							about this asset, including any notice already scheduled, and the
							asset shows as Unassigned until you attach its new owner. Their
							other assets and past assignments are kept. An agricultural
							customer's yearly AG renewal notice is about the customer, not the
							asset, so it continues — suspend the customer to stop it.
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							disabled={delinkCustomer.isPending}
							onClick={() => {
								if (!delinkTarget) return;
								delinkCustomer.mutate({
									assetId: delinkTarget.asset.id,
									customerId: delinkTarget.customer.id,
								});
							}}
						>
							{delinkCustomer.isPending ? "De-linking…" : "De-link asset"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** "3 customers · 5 assets" — both counts, now that each line is one asset. */
function listSummary(customers: Customer[], rows: CustomerRow[]) {
	const assets = rows.filter((row) => row.asset).length;
	return `${customers.length} ${customers.length === 1 ? "customer" : "customers"} · ${assets} ${assets === 1 ? "asset" : "assets"}`;
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
