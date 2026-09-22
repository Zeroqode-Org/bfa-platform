"use client";

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
import { cn } from "@bfa-platform/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { trpc } from "@/utils/trpc";

import type { FailAgeBand, FailListRow } from "./dashboard-types";
import {
	assetHref,
	failAgeBand,
	failingDays,
	formatCount,
	formatDay,
} from "./dashboard-types";

/**
 * The fail list: every assembly whose failure has gone 30 days without a
 * later submitted passing test, aged from the start of its failure episode.
 *
 * Everything about membership is the server's (`dashboard.failList`): computed
 * from submitted test history on every read, one row per asset, no stored
 * flag. The 30 days are the entry rule, applied there — the failure email went
 * out on the day of the fail, and this list is the follow-up for the ones
 * still unresolved a month later. What this component owns is presentation —
 * the two reachable age bands and the sorting.
 *
 * **Sorting is client-side over the full response.** The procedure returns the
 * whole list — a work queue bounded by the purveyor's assemblies with an
 * unresolved failure — already in the product's default order, oldest
 * unresolved failure first. Re-sorting a set that is already in hand is a
 * presentation choice, so it does not cost a round trip, and the default
 * state renders the server's order untouched.
 *
 * **The age bands are backgrounds, never the information.** Rows enter at 30
 * days, so there are two reachable bands: 30–60 days the stronger danger tint,
 * past 60 the full danger colour — design-system tokens (`danger-bg-strong`,
 * `danger` with its contrast foreground). The age itself is printed in the
 * row, so the bands remain a glance aid rather than the only carrier of the
 * fact.
 *
 * Each row leads to the existing asset detail route — the next action on a
 * failing assembly is on the asset, and a parallel detail view here would be a
 * second copy of it.
 */
export function FailListTable({ today }: { today: string }) {
	const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

	const failList = useQuery(trpc.dashboard.failList.queryOptions());

	const rows = useMemo(
		() => (failList.data ? sortRows(failList.data, sort) : []),
		[failList.data, sort],
	);

	const toggleSort = (key: SortKey) => {
		setSort((current) =>
			current.key === key
				? { key, direction: current.direction === "asc" ? "desc" : "asc" }
				: // A fresh column starts ascending; clicking it again flips it.
					{ key, direction: "asc" },
		);
	};

	return (
		<div className="relative overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
			<Table className="whitespace-nowrap">
				<TableHeader>
					<TableRow>
						{COLUMNS.map((column) => (
							<SortableHead
								key={column.key}
								column={column}
								sort={sort}
								onToggle={toggleSort}
							/>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{failList.isPending ? (
						<LoadingRows />
					) : failList.isError ? (
						<StateRow>
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<TriangleAlert className="text-danger" />
									</EmptyMedia>
									<EmptyTitle>Couldn&rsquo;t load the fail list</EmptyTitle>
									<EmptyDescription>{failList.error.message}</EmptyDescription>
								</EmptyHeader>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => failList.refetch()}
								>
									Try again
								</Button>
							</Empty>
						</StateRow>
					) : rows.length === 0 ? (
						<StateRow>
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<CircleCheck className="text-success" />
									</EmptyMedia>
									<EmptyTitle>Nothing on the fail list</EmptyTitle>
									<EmptyDescription>
										An assembly appears here once a failed test has gone 30 days
										without a passing re-test, and leaves as soon as a passing
										test is submitted. Newer failures are not listed yet — their
										failure email has already gone out. Drafts never count.
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						</StateRow>
					) : (
						rows.map((row) => <FailRow key={row.id} row={row} today={today} />)
					)}
				</TableBody>
			</Table>
		</div>
	);
}

type SortKey =
	| "failingSince"
	| "bin"
	| "bfaType"
	| "serviceAddress"
	| "customer";

type SortState = { key: SortKey; direction: "asc" | "desc" };

/** Oldest unresolved failure first — the server's own default order. */
const DEFAULT_SORT: SortState = { key: "failingSince", direction: "asc" };

const COLUMNS: readonly { key: SortKey; label: string }[] = [
	{ key: "bin", label: "BIN" },
	{ key: "bfaType", label: "BFA type" },
	{ key: "serviceAddress", label: "Service address" },
	{ key: "customer", label: "Current customer" },
	{ key: "failingSince", label: "Failing since" },
];

function sortValue(row: FailListRow, key: SortKey): string {
	if (key === "customer") return row.currentCustomerName ?? "";
	if (key === "failingSince") return row.failingSince;

	return row[key];
}

/**
 * A stable re-sort of the server's rows. Ties — two assets failing since the
 * same day, two rows with the same address — fall back to BIN then id, the
 * same tie-breakers the server uses, so equal rows cannot swap places between
 * renders.
 */
function sortRows(
	rows: readonly FailListRow[],
	sort: SortState,
): FailListRow[] {
	const direction = sort.direction === "asc" ? 1 : -1;

	return [...rows].sort((a, b) => {
		const primary = sortValue(a, sort.key).localeCompare(
			sortValue(b, sort.key),
			"en",
			{ numeric: true, sensitivity: "base" },
		);

		if (primary !== 0) return primary * direction;

		return (
			a.bin.localeCompare(b.bin, "en", { numeric: true }) ||
			a.id.localeCompare(b.id)
		);
	});
}

/**
 * One sortable header cell. The `<th>` carries `aria-sort` and the button
 * inside it is the control, so a screen reader hears both the state and the
 * action — the pattern the ARIA sortable-table example uses.
 */
function SortableHead({
	column,
	sort,
	onToggle,
}: {
	column: (typeof COLUMNS)[number];
	sort: SortState;
	onToggle: (key: SortKey) => void;
}) {
	const active = sort.key === column.key;

	return (
		<TableHead
			aria-sort={
				active
					? sort.direction === "asc"
						? "ascending"
						: "descending"
					: undefined
			}
		>
			<button
				type="button"
				onClick={() => onToggle(column.key)}
				className="inline-flex items-center gap-1 rounded-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
			>
				{column.label}
				{active ? (
					sort.direction === "asc" ? (
						<ArrowUp aria-hidden="true" className="size-3" />
					) : (
						<ArrowDown aria-hidden="true" className="size-3" />
					)
				) : null}
			</button>
		</TableHead>
	);
}

/**
 * The band's presentation, keyed by the same `failAgeBand` the tests assert
 * on. `over_60` is the design system's one sanctioned solid fill (build plan:
 * "the full danger colour"), so every piece of text in that row switches to
 * the contrast foreground.
 */
const BAND_STYLES: Record<
	FailAgeBand,
	{ row: string; cell: string; secondary: string; link: string }
> = {
	days_30_to_60: {
		row: "bg-danger-bg-strong",
		cell: "",
		secondary: "text-muted-foreground",
		link: "text-primary hover:underline",
	},
	over_60: {
		row: "bg-danger",
		// `TableCell` pins `text-foreground` per cell, so the contrast colour
		// has to be restated at the same level rather than inherited from the
		// row.
		cell: "text-danger-foreground",
		secondary: "text-danger-foreground/80",
		link: "text-danger-foreground underline hover:no-underline",
	},
};

/** One failing assembly. The BIN links to the existing asset detail route. */
function FailRow({ row, today }: { row: FailListRow; today: string }) {
	const days = failingDays(row.failingSince, today);
	const band = failAgeBand(days);
	const styles = BAND_STYLES[band];

	return (
		<TableRow className={styles.row}>
			<TableCell className={cn(styles.cell, "font-semibold")}>
				<Link
					href={assetHref(row.id)}
					className={cn(
						styles.link,
						"rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
					)}
				>
					{row.bin}
				</Link>
			</TableCell>
			<TableCell className={cn(styles.cell, styles.secondary)}>
				{row.bfaType}
			</TableCell>
			<TableCell className={styles.cell}>{row.serviceAddress}</TableCell>
			<TableCell className={styles.cell}>
				{row.currentCustomerName ?? (
					<span className={styles.secondary}>Unassigned</span>
				)}
			</TableCell>
			<TableCell className={cn(styles.cell, "tabular-nums")}>
				{formatDay(row.failingSince)}
				{/* The age in words, so the band's colour is a glance aid rather
				    than the only carrier of how old the failure is. */}
				<span className={cn("ml-2 text-[12px]", styles.secondary)}>
					{formatCount(days)} {days === 1 ? "day" : "days"}
				</span>
			</TableCell>
		</TableRow>
	);
}

/** One full-width cell for the three non-data states. */
function StateRow({ children }: { children: React.ReactNode }) {
	return (
		<TableRow>
			<TableCell colSpan={COLUMNS.length}>{children}</TableCell>
		</TableRow>
	);
}

/** Placeholder rows at the height the real ones will occupy. */
function LoadingRows() {
	return Array.from({ length: 5 }, (_, index) => (
		<TableRow
			// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list, never reordered
			key={index}
		>
			{COLUMNS.map((column) => (
				<TableCell key={column.key}>
					<Skeleton className="h-4 w-24 rounded-sm" />
				</TableCell>
			))}
		</TableRow>
	));
}
