"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
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
import { useQuery } from "@tanstack/react-query";
import { Building2, TriangleAlert } from "lucide-react";

import { impersonate, useImpersonation } from "@/lib/use-impersonation";
import { trpc } from "@/utils/trpc";

const countFormatter = new Intl.NumberFormat("en-US");

const COLUMN_COUNT = 7;
const SKELETON_ROWS = 4;

/**
 * Super-Admin cross-tenant list of every water purveyor, with the per-WP counts
 * from `superAdmin.listWaterPurveyors`. "Impersonate" still only flips the
 * local demo state that drives the impersonation banner (Week 4 wires the real
 * one). "Contact" has no source in the current schema, so it renders as an
 * em dash rather than inventing a value.
 */
export function WaterPurveyorsTable() {
	const impersonation = useImpersonation();
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.superAdmin.listWaterPurveyors.queryOptions(),
	);

	return (
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
								<Button variant="secondary" size="sm" onClick={() => refetch()}>
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
							const viewing =
								impersonation.isImpersonating &&
								impersonation.companyName === wp.companyName;

							return (
								<TableRow key={wp.id}>
									<TableCell className="font-semibold">
										{wp.companyName}
									</TableCell>
									<TableCell className="hidden text-muted-foreground min-[1180px]:table-cell">
										&mdash;
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
										<Button
											variant="secondary"
											size="sm"
											disabled={viewing}
											onClick={() => impersonate(wp.companyName)}
										>
											{viewing ? "Viewing" : "Impersonate"}
										</Button>
									</TableCell>
								</TableRow>
							);
						})
					)}
				</TableBody>
			</Table>
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
