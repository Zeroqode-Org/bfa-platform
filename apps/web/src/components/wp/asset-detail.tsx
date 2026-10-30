"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import { Card } from "@bfa-platform/ui/components/card";
import {
	Dialog,
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
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { PageTitle } from "@bfa-platform/ui/components/page-title";
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
import { required } from "@bfa-platform/ui/lib/validation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

import { EditAssetForm } from "./asset-form";
import type { AssetAssignment, AssetDetail } from "./asset-types";
import {
	ASSET_STATUS_LABELS,
	ASSET_STATUS_VARIANTS,
	assetFormErrors,
	formatAssetDate,
	nextAssignAction,
	SUSPENDED_CUSTOMER_NOTE,
} from "./asset-types";
import {
	CustomerForm,
	customerFormErrors,
	emptyCustomerValues,
} from "./customer-form";

/**
 * One asset, everything known about it, and the two things a WP does to it from
 * here: correct its details, and attach a customer.
 *
 * The customer control is not a field on the asset form. Attaching one closes
 * the outgoing occupancy row and opens a new one in the same transaction, so it
 * is its own act with its own record — and the history below is why: a pointer
 * answers "who gets the email", but a disputed test needs "who had this valve
 * in March".
 */
export function AssetDetailView({ assetId }: { assetId: string }) {
	const queryClient = useQueryClient();
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.assets.getAsset.queryOptions({ id: assetId }),
	);

	if (isPending) return <DetailSkeleton />;

	if (isError) {
		return (
			<div className="flex flex-col gap-5">
				<BackLink />
				<Card className="p-6">
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<TriangleAlert className="text-danger" />
							</EmptyMedia>
							<EmptyTitle>Couldn&rsquo;t load this asset</EmptyTitle>
							<EmptyDescription>{error.message}</EmptyDescription>
						</EmptyHeader>
						<Button variant="secondary" size="sm" onClick={() => refetch()}>
							Try again
						</Button>
					</Empty>
				</Card>
			</div>
		);
	}

	return (
		<LoadedAsset
			detail={data}
			onChanged={async () => {
				await queryClient.invalidateQueries({
					queryKey: trpc.assets.getAsset.queryKey({ id: assetId }),
				});
				await queryClient.invalidateQueries({
					queryKey: trpc.assets.listAssets.queryKey(),
				});
			}}
		/>
	);
}

function LoadedAsset({
	detail,
	onChanged,
}: {
	detail: AssetDetail;
	onChanged: () => Promise<void>;
}) {
	const { asset, assignments } = detail;
	const [isEditOpen, setIsEditOpen] = useState(false);

	const saveAsset = useMutation(
		trpc.assets.updateAsset.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`${row.bin ?? "Asset"} saved`);
				await onChanged();
				setIsEditOpen(false);
			},
		}),
	);

	return (
		<div className="flex flex-col gap-5">
			<BackLink />

			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-2">
					<PageTitle kicker="BFA asset">{asset.bin ?? "No BIN"}</PageTitle>
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant={ASSET_STATUS_VARIANTS[asset.assetStatus]}>
							{ASSET_STATUS_LABELS[asset.assetStatus]}
						</Badge>
						<span className="text-[13px] text-muted-foreground">
							{asset.bfaType} · {asset.serviceAddress}
						</span>
					</div>
				</div>

				<Button
					variant="secondary"
					size="sm"
					onClick={() => {
						saveAsset.reset();
						setIsEditOpen(true);
					}}
				>
					{asset.bin ? "Edit asset" : "Assign BIN"}
				</Button>
			</div>

			{/* A no-BIN asset: registered by the certifier wizard from a test whose
			    BIN was blank or not found. The purveyor numbers it here. */}
			{asset.bin ? null : (
				<p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[12px] text-warning">
					<TriangleAlert
						className="mt-px size-3.5 shrink-0"
						aria-hidden="true"
					/>
					Registered from a test submitted with no BIN. Assign its BIN and
					attach the customer — its test result and notices start once it has a
					BIN. If this assembly is already registered, link the test to that
					asset from Submitted Tests instead; this empty one is then removed.
				</p>
			)}

			<div className="grid gap-4 min-[980px]:grid-cols-[minmax(0,1fr)_340px]">
				<Card className="flex flex-col gap-4 p-5">
					<h2 className="font-bold text-[15.5px]">Assembly details</h2>
					<dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
						<Fact label="BFA type" value={asset.bfaType} />
						<Fact
							label="Annual test date"
							value={formatAssetDate(asset.annualTestDate)}
						/>
						<Fact label="Make" value={asset.make} />
						<Fact label="Model" value={asset.model} />
						<Fact label="Serial number" value={asset.serialNumber} />
						<Fact label="Size" value={asset.size} />
						<Fact label="Service address" value={asset.serviceAddress} />
						<Fact label="Assembly location" value={asset.assemblyLocation} />
					</dl>
					{/* The status is read-only everywhere, so the one place it is
					    explained is next to where it is shown. */}
					<p className="text-[12px] text-muted-foreground">
						Status is recalculated from the annual test date — change the date
						to move it.
					</p>
				</Card>

				<CustomerPanel detail={detail} onChanged={onChanged} />
			</div>

			<AssignmentHistory assignments={assignments} />

			<Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
				{/* overflow-hidden: `EditAssetForm` pins its own footer and scrolls
				    its fields, so the popup clips instead of scrolling too. */}
				<DialogContent className="max-w-[560px] overflow-hidden">
					<DialogHeader>
						<DialogTitle>{asset.bin ? "Edit asset" : "Assign BIN"}</DialogTitle>
						<DialogDescription>
							{asset.bin
								? "Every field can be corrected, the BIN included — a BIN change is recorded with both values."
								: "Give this assembly its BIN. Every other field can be corrected here too."}
						</DialogDescription>
					</DialogHeader>
					<EditAssetForm
						key={asset.id}
						asset={asset}
						pending={saveAsset.isPending}
						{...assetFormErrors(saveAsset.isError ? saveAsset.error : null)}
						onCancel={() => setIsEditOpen(false)}
						onSubmit={(payload) =>
							saveAsset.mutate({ id: asset.id, ...payload })
						}
					/>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * Who currently holds the asset, and the control that changes it.
 *
 * The customer list is the caller's own purveyor's — the same WP-scoped
 * `listCustomers` the customers screen reads — so there is no customer from
 * another tenant to pick in the first place. The server checks tenancy again
 * anyway, because a control that cannot offer the wrong answer is not the same
 * thing as a procedure that would refuse one.
 */
function CustomerPanel({
	detail,
	onChanged,
}: {
	detail: AssetDetail;
	onChanged: () => Promise<void>;
}) {
	const { asset, testCustomer } = detail;
	const [isAssignOpen, setIsAssignOpen] = useState(false);
	// The customer the assign dialog opens on — the test's, when the WP takes
	// the suggestion below.
	const [preselected, setPreselected] = useState<string | null>(null);
	const [isCreateFromTestOpen, setIsCreateFromTestOpen] = useState(false);

	return (
		<Card className="flex flex-col gap-4 p-5">
			<h2 className="font-bold text-[15.5px]">Current customer</h2>

			{asset.currentCustomerName ? (
				<div className="flex flex-col gap-1.5">
					<span className="font-semibold text-[14.5px]">
						{asset.currentCustomerName}
					</span>
					{asset.currentCustomerStatus === "suspended" ? (
						<p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[12px] text-warning">
							<TriangleAlert
								className="mt-px size-3.5 shrink-0"
								aria-hidden="true"
							/>
							{SUSPENDED_CUSTOMER_NOTE}
						</p>
					) : null}
				</div>
			) : (
				<p className="text-[13px] text-muted-foreground">
					Nobody is attached, so this asset&rsquo;s automated email has nowhere
					to go.
				</p>
			)}

			{testCustomer ? (
				<TestCustomerSuggestion
					suggestion={testCustomer}
					assetHasBin={asset.bin !== null}
					onAttach={(customerId) => {
						setPreselected(customerId);
						setIsAssignOpen(true);
					}}
					onCreate={() => setIsCreateFromTestOpen(true)}
				/>
			) : null}

			<div className="flex flex-col gap-2">
				<Button
					size="sm"
					variant={testCustomer ? "secondary" : "default"}
					onClick={() => {
						setPreselected(null);
						setIsAssignOpen(true);
					}}
				>
					{asset.currentCustomerId ? "Change customer" : "Attach customer"}
				</Button>
				<p className="text-[12px] text-muted-foreground">
					Attaching a different customer closes the current assignment with
					today&rsquo;s date and starts a new one — the previous occupancy is
					kept.
				</p>
			</div>

			<AssignCustomerDialog
				open={isAssignOpen}
				onOpenChange={setIsAssignOpen}
				detail={detail}
				preselected={preselected}
				onChanged={onChanged}
			/>

			{testCustomer ? (
				<CreateCustomerFromTestDialog
					open={isCreateFromTestOpen}
					onOpenChange={setIsCreateFromTestOpen}
					assetBin={asset.bin}
					suggestion={testCustomer}
					onChanged={onChanged}
				/>
			) : null}
		</Card>
	);
}

type TestCustomer = NonNullable<AssetDetail["testCustomer"]>;

/**
 * The customer the certifier recorded on this asset's latest test, offered as
 * the one to attach while nobody is. Nothing is attached or created until the WP says so
 * (client, October 2026: the WP links the new asset to its customer by hand).
 */
function TestCustomerSuggestion({
	suggestion,
	assetHasBin,
	onAttach,
	onCreate,
}: {
	suggestion: TestCustomer;
	assetHasBin: boolean;
	onAttach: (customerId: string) => void;
	onCreate: () => void;
}) {
	const { name, email, match } = suggestion;

	return (
		<div className="flex flex-col gap-2 rounded-md bg-accent px-3 py-2.5 text-[12px] text-accent-foreground">
			<p>
				<span className="font-semibold">From the test:</span>{" "}
				{[name, email].filter(Boolean).join(" · ")}
			</p>
			{match ? (
				<>
					<p>
						{match.name} already has this email
						{match.status === "suspended" ? " and is suspended" : ""}.
					</p>
					<Button size="sm" onClick={() => onAttach(match.id)}>
						Attach {match.name}
					</Button>
				</>
			) : assetHasBin ? (
				<>
					<p>No customer has this email yet.</p>
					<Button size="sm" onClick={onCreate}>
						Create customer from test
					</Button>
				</>
			) : (
				// A new customer is attached through a BIN (`createCustomer`'s
				// `attachBin`), so this asset needs its BIN first.
				<p>
					No customer has this email yet. Assign the BIN first — a new customer
					is created through it.
				</p>
			)}
		</div>
	);
}

/**
 * A new customer from the test's details, attached to this asset through its
 * BIN — `createCustomer` attaches the customer to the asset its `attachBin`
 * names. The customer form opens filled in from the test (standard rate,
 * active, this asset's BIN) for the WP to check and complete before anything
 * is saved.
 */
function CreateCustomerFromTestDialog({
	open,
	onOpenChange,
	assetBin,
	suggestion,
	onChanged,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	assetBin: string | null;
	suggestion: TestCustomer;
	onChanged: () => Promise<void>;
}) {
	const queryClient = useQueryClient();
	const createCustomer = useMutation(
		trpc.customers.createCustomer.mutationOptions({
			onSuccess: async (customer) => {
				toast.success(`${customer.name} added and attached`);
				onOpenChange(false);
				await queryClient.invalidateQueries({
					queryKey: trpc.customers.listCustomers.queryKey(),
				});
				await onChanged();
			},
		}),
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[560px] overflow-hidden">
				<DialogHeader>
					<DialogTitle>Create customer from test</DialogTitle>
					<DialogDescription>
						Filled in from what the certifier recorded. Check it, complete it,
						and save — the new customer is attached to this asset.
					</DialogDescription>
				</DialogHeader>
				<CustomerForm
					initialValues={{
						...emptyCustomerValues,
						name: suggestion.name,
						email: suggestion.email ?? "",
						attachBin: assetBin ?? "",
						rateCategory: "standard",
						status: "active",
					}}
					pending={createCustomer.isPending}
					{...customerFormErrors(
						createCustomer.isError ? createCustomer.error : null,
					)}
					submitLabel="Create and attach"
					pendingLabel="Saving…"
					onCancel={() => onOpenChange(false)}
					onSubmit={(payload) => createCustomer.mutate(payload)}
				/>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The attach-a-customer modal.
 *
 * The list is `listCustomers`, which is WP-scoped, so there is no customer from
 * another tenant to pick in the first place — and the server checks tenancy
 * again anyway, because a control that cannot offer the wrong answer is not the
 * same thing as a procedure that would refuse one.
 *
 * Two answers the dialog will not simply send. The customer who is already
 * attached is disabled in the list and named as such, because re-attaching them
 * is not a move and the server would return the asset unchanged. And a
 * suspended customer goes through a confirmation first: attaching one stops
 * this asset's automated email entirely, and `assignCustomer` refuses without
 * the acknowledgement this step sets — the dialog is how the flag gets set, not
 * where the rule lives.
 */
function AssignCustomerDialog({
	open,
	onOpenChange,
	detail,
	preselected = null,
	onChanged,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	detail: AssetDetail;
	/** The customer the dialog opens on, if any — still confirmed with Attach. */
	preselected?: string | null;
	onChanged: () => Promise<void>;
}) {
	const { asset } = detail;
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		if (open) setSelected(preselected);
	}, [open, preselected]);
	const [isConfirmingSuspended, setIsConfirmingSuspended] = useState(false);

	const customers = useQuery(trpc.customers.listCustomers.queryOptions());

	// The one real choice in this dialog: there is no sensible default customer,
	// so pressing Attach without one says so under the picker rather than
	// leaving a disabled button to interpret.
	const validation = useFormValidation({
		values: { customerId: selected ?? "" },
		rules: { customerId: required("Choose a customer to attach.") },
	});

	const assignCustomer = useMutation(
		trpc.assets.assignCustomer.mutationOptions({
			onSuccess: async (result) => {
				toast.success(
					result.asset.currentCustomerName
						? `${result.asset.currentCustomerName} is now on ${result.asset.bin ?? "this asset"}`
						: `${result.asset.bin ?? "Asset"} updated`,
				);
				close();
				await onChanged();
			},
			// No toast on failure: the refusal is shown inside the dialog, above
			// the buttons, while the choice it is about is still on screen.
		}),
	);

	function close() {
		setSelected(null);
		setIsConfirmingSuspended(false);
		validation.reset();
		assignCustomer.reset();
		onOpenChange(false);
	}

	const options = customers.data ?? [];
	const items = Object.fromEntries(
		options.map((customer) => [customer.id, customer.name]),
	);
	const chosen = options.find((customer) => customer.id === selected);
	const chosenIsSuspended = chosen?.status === "suspended";
	const action = nextAssignAction({
		customer: chosen,
		currentCustomerId: asset.currentCustomerId,
		suspensionConfirmed: isConfirmingSuspended,
	});

	function attach() {
		if (!validation.validate()) return;

		// The consequence is large enough to be worth one more click. Only the
		// second press carries the acknowledgement the server requires.
		if (action === "confirm-suspended") {
			setIsConfirmingSuspended(true);
			return;
		}

		if (action === "blocked" || !chosen) return;

		assignCustomer.mutate({
			assetId: asset.id,
			customerId: chosen.id,
			acknowledgeSuspendedCustomer: chosenIsSuspended,
		});
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) close();
				else onOpenChange(true);
			}}
		>
			<DialogContent className="max-w-[460px]">
				<DialogHeader>
					<DialogTitle>
						{isConfirmingSuspended
							? `Attach ${chosen?.name}, who is suspended?`
							: "Attach a customer"}
					</DialogTitle>
					<DialogDescription>
						{isConfirmingSuspended
							? "Their automated email is paused, so this asset's reminders and late notices stop until a different customer is attached to the BIN."
							: `Automated email for ${asset.bin ?? "this asset"} goes to whoever is attached here. The current assignment is closed with today's date and kept.`}
					</DialogDescription>
				</DialogHeader>

				{isConfirmingSuspended ? null : (
					<div className="flex flex-col gap-2">
						<Select
							items={items}
							value={selected}
							onValueChange={(value) => setSelected(value as string)}
							disabled={customers.isPending || assignCustomer.isPending}
						>
							<SelectTrigger
								{...validation.controlProps("customerId")}
								aria-label="Choose a customer to attach"
							>
								<SelectValue placeholder="Choose a customer…" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{options.map((customer) => (
										<SelectItem
											key={customer.id}
											value={customer.id}
											// Already attached: nothing to do, and the server
											// would return the asset unchanged.
											disabled={customer.id === asset.currentCustomerId}
										>
											{customer.name}
											{customer.id === asset.currentCustomerId
												? " — current"
												: customer.status === "suspended"
													? " — suspended"
													: ""}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						<FieldError {...validation.errorProps("customerId")} />

						{/* Said beside the choice, before the confirmation, so the
						    consequence is visible while the list is still open. */}
						{chosenIsSuspended ? (
							<p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[12px] text-warning">
								<TriangleAlert
									className="mt-px size-3.5 shrink-0"
									aria-hidden="true"
								/>
								{chosen?.name} is suspended. {SUSPENDED_CUSTOMER_NOTE}
							</p>
						) : null}

						{options.length === 0 && !customers.isPending ? (
							<p className="text-[12px] text-muted-foreground">
								No customers yet —{" "}
								<Link
									href="/wp/customers"
									className="text-primary hover:underline"
								>
									add one
								</Link>{" "}
								and it can be attached here.
							</p>
						) : null}
					</div>
				)}

				<FormError
					message={assignCustomer.isError ? assignCustomer.error.message : null}
				/>

				<DialogFooter>
					<Button
						variant="secondary"
						disabled={assignCustomer.isPending}
						onClick={() =>
							isConfirmingSuspended ? setIsConfirmingSuspended(false) : close()
						}
					>
						{isConfirmingSuspended ? "Back" : "Cancel"}
					</Button>
					<Button
						variant={isConfirmingSuspended ? "destructive" : "default"}
						// Only in flight is it unavailable. With nothing chosen, pressing it
						// explains what is missing; the current occupant is not selectable.
						disabled={assignCustomer.isPending}
						onClick={attach}
					>
						{assignCustomer.isPending
							? "Attaching…"
							: isConfirmingSuspended
								? "Attach and pause email"
								: "Attach customer"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The full occupancy record, newest first, open assignment at the top. */
function AssignmentHistory({
	assignments,
}: {
	assignments: AssetAssignment[];
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 className="font-bold text-[15.5px]">Assignment history</h2>
				<p className="text-[13px] text-muted-foreground">
					Every customer this asset has had, and for how long.
				</p>
			</div>

			<div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>Customer</TableHead>
							<TableHead>Start date</TableHead>
							<TableHead>End date</TableHead>
							<TableHead>State</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{assignments.length === 0 ? (
							<TableRow>
								<TableCell colSpan={4} className="whitespace-normal p-0">
									<Empty>
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<Users />
											</EmptyMedia>
											<EmptyTitle>No customer has held this asset</EmptyTitle>
											<EmptyDescription>
												Attach one above and the assignment starts today.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								</TableCell>
							</TableRow>
						) : (
							assignments.map((assignment) => (
								<TableRow key={assignment.id}>
									<TableCell className="font-semibold">
										{/* The name is null only when the assignment points at a
										    customer outside this purveyor — a data problem the
										    read path withholds the name for rather than leaking
										    it. The occupancy itself is this purveyor's record and
										    still shows, so the cell says what it cannot show
										    instead of going quietly blank. */}
										{assignment.customerName ?? (
											<span className="font-normal text-muted-foreground">
												Unknown customer
											</span>
										)}
									</TableCell>
									<TableCell className="tabular-nums">
										{formatAssetDate(assignment.startDate)}
									</TableCell>
									<TableCell className="text-muted-foreground tabular-nums">
										{assignment.endDate
											? formatAssetDate(assignment.endDate)
											: "—"}
									</TableCell>
									<TableCell>
										{assignment.endDate === null ? (
											<Badge variant="success">Current</Badge>
										) : (
											<Badge variant="neutral">Ended</Badge>
										)}
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function Fact({ label, value }: { label: string; value: string | null }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="text-[12px] text-muted-foreground">{label}</dt>
			<dd className="text-[14px] text-foreground">{value || "—"}</dd>
		</div>
	);
}

function BackLink() {
	return (
		<Link
			href="/wp/assets"
			className="flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
		>
			<ArrowLeft className="size-4" aria-hidden="true" />
			All assets
		</Link>
	);
}

function DetailSkeleton() {
	return (
		<div className="flex flex-col gap-5">
			<Skeleton className="h-4 w-24 rounded-sm" />
			<Skeleton className="h-8 w-48 rounded-sm" />
			<div className="grid gap-4 min-[980px]:grid-cols-[minmax(0,1fr)_340px]">
				<Skeleton className="h-64 rounded-lg" />
				<Skeleton className="h-64 rounded-lg" />
			</div>
			<Skeleton className="h-40 rounded-lg" />
		</div>
	);
}
