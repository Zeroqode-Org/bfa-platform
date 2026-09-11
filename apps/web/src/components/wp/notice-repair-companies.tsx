"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button, buttonVariants } from "@bfa-platform/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@bfa-platform/ui/components/card";
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
import { TriangleAlert, Wrench } from "lucide-react";
import Link from "next/link";

import { trpc } from "@/utils/trpc";

const COLUMN_COUNT = 4;
const SKELETON_ROWS = 3;

/**
 * The approved repair companies, read-only, on the notices screen.
 *
 * It is here because it is part of what a notice says: when a certifier files a
 * failed test, the failure notice tells the customer who to call, and it names
 * the active companies on this list resolved at send time. Somebody editing
 * notice text needs to be able to see that list without leaving the page.
 *
 * Read-only, and deliberately so. Add, edit and deactivate live on
 * `/wp/repair-companies`, which is the management screen; duplicating those
 * controls here would mean two places to keep in step and two places a
 * deactivation could be started from. The link below is the whole affordance.
 */
export function NoticeRepairCompanies() {
	const { data, isPending, isError, error, refetch } = useQuery(
		trpc.repairCompanies.listRepairCompanies.queryOptions(),
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Repair companies</CardTitle>
				<CardDescription>
					Who a failure notice tells your customers to call. Only{" "}
					<strong className="font-semibold text-foreground">active</strong>{" "}
					companies are named, and the list is resolved when the notice is sent.
					Manage them on{" "}
					<Link
						href="/wp/repair-companies"
						className="font-semibold text-primary underline-offset-4 hover:underline"
					>
						Repair Companies
					</Link>
					.
				</CardDescription>
			</CardHeader>

			<CardContent>
				<div className="overflow-x-auto rounded-lg border border-border">
					<Table className="whitespace-nowrap">
						<TableHeader>
							<TableRow>
								<TableHead>Company</TableHead>
								<TableHead>Phone</TableHead>
								<TableHead>Email</TableHead>
								<TableHead>Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{isPending ? (
								Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
									<TableRow key={rowIndex}>
										{Array.from({ length: COLUMN_COUNT }, (_, cellIndex) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
											<TableCell key={cellIndex}>
												<Skeleton className="h-4 w-full rounded-sm" />
											</TableCell>
										))}
									</TableRow>
								))
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
												Until one is added, a failure notice has nowhere to send
												the customer.
											</EmptyDescription>
										</EmptyHeader>
										{/* A link wearing a button's styling — `buttonVariants`
										    rather than `<Button render={<Link/>}>`.

										    Base UI's Button assumes it renders a native
										    <button>, and an anchor in its `render` prop makes it
										    warn. `nativeButton={false}` silences that warning by
										    making the primitive shim the anchor *into* a button:
										    it stamps `role="button"`, which is the worse of the
										    two outcomes. This control navigates, so a screen
										    reader should announce a link and the browser should
										    offer middle-click and open-in-new-tab. Taking the
										    class names and leaving the element alone is what
										    keeps the semantics honest — the styling was the only
										    thing wanted from Button here. */}
										<Link
											href="/wp/repair-companies"
											className={buttonVariants({
												variant: "secondary",
												size: "sm",
											})}
										>
											Go to Repair Companies
										</Link>
									</Empty>
								</StateRow>
							) : (
								data.map((company) => (
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
											{company.status === "inactive" ? (
												<Badge variant="warning">Not in failure notices</Badge>
											) : (
												<Badge variant="success">Active</Badge>
											)}
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>
			</CardContent>
		</Card>
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
