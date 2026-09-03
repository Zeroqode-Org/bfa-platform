"use client";

import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@bfa-platform/ui/components/table";

import { waterPurveyorFixtures } from "@/lib/fixtures/water-purveyors";
import { impersonate, useImpersonation } from "@/lib/use-impersonation";

const countFormatter = new Intl.NumberFormat("en-US");

/**
 * Super-Admin cross-tenant list of every water purveyor, with the per-WP counts
 * the Week 4 `listWaterPurveyors` procedure will supply. Week 1 renders the
 * fixtures and the "Impersonate" action only flips the local demo state that
 * drives the impersonation banner.
 */
export function WaterPurveyorsTable() {
	const impersonation = useImpersonation();

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
					{waterPurveyorFixtures.map((wp) => {
						const viewing =
							impersonation.isImpersonating &&
							impersonation.companyName === wp.company;

						return (
							<TableRow key={wp.id}>
								<TableCell className="font-semibold">{wp.company}</TableCell>
								<TableCell className="hidden text-muted-foreground min-[1180px]:table-cell">
									{wp.contact}
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
										onClick={() => impersonate(wp.company)}
									>
										{viewing ? "Viewing" : "Impersonate"}
									</Button>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
