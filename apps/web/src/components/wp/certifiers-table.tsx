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
import { Ban, TriangleAlert, UserCheck } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

import type { CertifierType, WpCertifier } from "./certifier-types";
import {
	BLOCK_SCOPE_NOTE,
	BLOCK_WARNING,
	CERTIFIER_STATUS_LABELS,
	CERTIFIER_STATUS_VARIANTS,
	CERTIFIER_TYPE_LABELS,
	formatLicenseDate,
	isLicenseExpired,
} from "./certifier-types";
import { InviteCertifierDialog } from "./invite-certifier-dialog";

const COLUMN_COUNT = 6;
const SKELETON_ROWS = 4;

/** The tabs, in the order the client named them. */
const CERTIFIER_TYPES = ["internal", "external"] as const;

const OTHER_TYPE: Record<CertifierType, CertifierType> = {
	internal: "external",
	external: "internal",
};

/**
 * The certifiers authorized for this water purveyor, and the one action the
 * purveyor has over them: block and unblock.
 *
 * Nothing else on a row is editable here. Name, company, certifier ID and
 * licence expiry are the certifier's own record — they entered them when they
 * redeemed their invitation and they maintain them from their own profile. A WP
 * that could rewrite them could rewrite the identity printed on a results
 * document.
 *
 * The list is split into Internal and External tabs — the purveyor's own
 * staff and the private testers it accepts reports from — and a row can be
 * moved to the other tab. That type is the purveyor's own word about the
 * certifier, kept on its authorization, so moving one here changes nothing for
 * any other purveyor they work for.
 *
 * Blocking is the one action with a consequence past this table, so it asks
 * first and says what it does; unblocking goes straight through — giving
 * somebody their access back is not the destructive direction. Nothing here
 * deletes: there is no delete control, no delete procedure and no DELETE grant
 * behind it.
 *
 * `canManage` is what the screen renders, not what it is allowed to do: the
 * row actions are hidden from a WP Employee because both procedures refuse
 * them, and each procedure checks the role again for itself.
 */
export function CertifiersTable({ canManage }: { canManage: boolean }) {
	const queryClient = useQueryClient();
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.certifiers.listWpCertifiers.queryOptions(),
	);

	// Null until somebody picks a tab — see `shownType` below.
	const [chosenType, setChosenType] = useState<CertifierType | null>(null);
	const tabsId = useId();
	const tabRefs = useRef<Partial<Record<CertifierType, HTMLButtonElement>>>({});
	// Open state is tracked next to the target, not derived from it, so a name
	// stays on screen through the dialog's closing animation instead of blanking.
	const [blockTarget, setBlockTarget] = useState<WpCertifier | null>(null);
	const [isBlockOpen, setIsBlockOpen] = useState(false);

	function invalidateList() {
		return queryClient.invalidateQueries({
			queryKey: trpc.certifiers.listWpCertifiers.queryKey(),
		});
	}

	const setStatus = useMutation(
		trpc.certifiers.setCertifierStatus.mutationOptions({
			onSuccess: async (row) => {
				const name = row.fullName ?? "Certifier";
				toast.success(
					row.status === "blocked"
						? `${name} blocked — they can no longer sign in`
						: `${name} unblocked`,
				);
				await invalidateList();
				setIsBlockOpen(false);
			},
			// No inline place to put a message on a row action, so it gets a toast.
			onError: (mutationError) => toast.error(mutationError.message),
		}),
	);

	const setType = useMutation(
		trpc.certifiers.setCertifierType.mutationOptions({
			onSuccess: async (row) => {
				toast.success(
					`${row.fullName ?? "Certifier"} moved to ${CERTIFIER_TYPE_LABELS[
						row.certifierType
					].toLowerCase()} certifiers`,
				);
				await invalidateList();
			},
			onError: (mutationError) => toast.error(mutationError.message),
		}),
	);

	const byType = data ? groupByType(data) : undefined;
	// Until a tab is picked, open on Internal unless it is empty and External is
	// not. Every authorization from before the type existed is external, so a
	// fixed Internal default would greet each purveyor after the release with an
	// empty screen and their whole list hidden behind the other tab.
	const activeType: CertifierType =
		chosenType ??
		(byType && byType.internal.length === 0 && byType.external.length > 0
			? "external"
			: "internal");
	const rows = byType?.[activeType];

	function tabId(type: CertifierType) {
		return `${tabsId}-tab-${type}`;
	}

	// Left and Right move between the two tabs and select the one they land
	// on, as the ARIA tab pattern expects.
	function handleTabKey(event: React.KeyboardEvent<HTMLDivElement>) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const next = OTHER_TYPE[activeType];
		setChosenType(next);
		tabRefs.current[next]?.focus();
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div
					role="tablist"
					aria-label="Certifier type"
					className="flex flex-wrap gap-1.5"
					onKeyDown={handleTabKey}
				>
					{CERTIFIER_TYPES.map((type) => {
						const active = type === activeType;
						const count = byType?.[type].length;

						return (
							<Button
								key={type}
								ref={(element) => {
									if (element) tabRefs.current[type] = element;
								}}
								id={tabId(type)}
								type="button"
								role="tab"
								aria-selected={active}
								aria-controls={`${tabsId}-panel`}
								tabIndex={active ? 0 : -1}
								variant={active ? "default" : "outline"}
								size="sm"
								onClick={() => setChosenType(type)}
							>
								{CERTIFIER_TYPE_LABELS[type]} certifiers
								{count === undefined ? null : (
									<span className="tabular-nums opacity-70">{count}</span>
								)}
							</Button>
						);
					})}
				</div>
				<InviteCertifierDialog />
			</div>

			<div
				id={`${tabsId}-panel`}
				role="tabpanel"
				aria-labelledby={tabId(activeType)}
				className="relative overflow-x-auto rounded-lg border border-border bg-card shadow-[var(--shadow-card)]"
			>
				<Table className="whitespace-nowrap">
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Company</TableHead>
							<TableHead>ID number</TableHead>
							<TableHead>License expiration</TableHead>
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
										<EmptyTitle>Couldn&rsquo;t load certifiers</EmptyTitle>
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
						) : rows?.length === 0 ? (
							<StateRow>
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<UserCheck />
										</EmptyMedia>
										<EmptyTitle>
											No {CERTIFIER_TYPE_LABELS[activeType].toLowerCase()}{" "}
											certifiers yet
										</EmptyTitle>
										<EmptyDescription>
											{data.length === 0
												? "Invite one and they appear here as soon as they redeem the link."
												: `Invite one as ${activeType}, or move a certifier here from the ${CERTIFIER_TYPE_LABELS[
														OTHER_TYPE[activeType]
													].toLowerCase()} tab.`}
										</EmptyDescription>
									</EmptyHeader>
									<InviteCertifierDialog />
								</Empty>
							</StateRow>
						) : (
							rows?.map((certifier) => {
								const blocked = certifier.status === "blocked";
								// One mutation drives every row's status button, so scope its
								// pending state to the row actually being changed — otherwise
								// blocking one certifier relabels the button on all of them.
								const statusPending =
									setStatus.isPending &&
									setStatus.variables?.id === certifier.id;
								const typePending =
									setType.isPending && setType.variables?.id === certifier.id;
								const otherType = OTHER_TYPE[certifier.certifierType];
								const expired = isLicenseExpired(
									certifier.licenseExpirationDate,
								);

								return (
									<TableRow key={certifier.id}>
										<TableCell className="font-semibold">
											{certifier.fullName ?? "—"}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{certifier.company ?? "—"}
										</TableCell>
										<TableCell className="text-muted-foreground tabular-nums">
											{certifier.idNumber ?? "—"}
										</TableCell>
										<TableCell className="tabular-nums">
											<div className="flex flex-col items-start gap-1">
												<span
													className={
														expired ? "text-danger" : "text-muted-foreground"
													}
												>
													{formatLicenseDate(certifier.licenseExpirationDate)}
												</span>
												{/* A lapsed licence is not a status the purveyor set,
												    so it is a note rather than a badge — but it is the
												    reason a WP would look at this screen at all. */}
												{expired ? (
													<span className="text-[11px] text-danger">
														License expired
													</span>
												) : null}
											</div>
										</TableCell>
										<TableCell>
											<div className="flex flex-col items-start gap-1">
												<Badge
													variant={CERTIFIER_STATUS_VARIANTS[certifier.status]}
												>
													{blocked ? <Ban aria-hidden="true" /> : null}
													{CERTIFIER_STATUS_LABELS[certifier.status]}
												</Badge>
												{/* Says what the status means here, rather than
												    leaving "blocked" to be interpreted. */}
												{blocked ? (
													<span className="text-[11px] text-muted-foreground">
														Cannot sign in
													</span>
												) : null}
											</div>
										</TableCell>
										<TableCell className="text-right">
											{canManage ? (
												<div className="flex justify-end gap-2">
													<Button
														variant="secondary"
														size="sm"
														disabled={typePending}
														aria-label={`Move ${certifier.fullName ?? "certifier"} to ${CERTIFIER_TYPE_LABELS[otherType].toLowerCase()} certifiers`}
														onClick={() =>
															setType.mutate({
																id: certifier.id,
																certifierType: otherType,
															})
														}
													>
														{typePending
															? "Moving…"
															: `Make ${CERTIFIER_TYPE_LABELS[otherType].toLowerCase()}`}
													</Button>
													<Button
														variant={blocked ? "secondary" : "destructive"}
														size="sm"
														disabled={statusPending}
														aria-label={
															blocked
																? `Unblock ${certifier.fullName ?? "certifier"}`
																: `Block ${certifier.fullName ?? "certifier"}`
														}
														onClick={() => {
															if (blocked) {
																setStatus.mutate({
																	id: certifier.id,
																	status: "active",
																});
																return;
															}
															setBlockTarget(certifier);
															setIsBlockOpen(true);
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
												</div>
											) : null}
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</div>

			<Dialog open={isBlockOpen} onOpenChange={setIsBlockOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Block {blockTarget?.fullName ?? "this certifier"}?
						</DialogTitle>
						<DialogDescription>
							{BLOCK_WARNING} {BLOCK_SCOPE_NOTE} Their submitted tests are
							unaffected and drafts are kept — unblocking from the same button
							gives their access back.
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							disabled={setStatus.isPending}
							onClick={() => {
								if (!blockTarget) return;
								setStatus.mutate({ id: blockTarget.id, status: "blocked" });
							}}
						>
							{setStatus.isPending ? "Blocking…" : "Block certifier"}
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

function groupByType(certifiers: WpCertifier[]) {
	const groups: Record<CertifierType, WpCertifier[]> = {
		internal: [],
		external: [],
	};

	for (const certifier of certifiers)
		groups[certifier.certifierType].push(certifier);

	return groups;
}
