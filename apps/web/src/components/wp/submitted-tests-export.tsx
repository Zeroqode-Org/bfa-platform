"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { SubmissionResult } from "./submission-types";

/** The Submitted Tests screen's filters, as the export route takes them. */
export type ExportFilters = {
	result?: SubmissionResult;
	from?: string;
	to?: string;
};

/**
 * The export route's URL for these filters. An absent filter is left out of
 * the query string rather than sent empty — the route's input is strict, and
 * an empty bound is not a date.
 */
export function exportUrl(filters: ExportFilters) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value) params.set(key, value);
	}
	const query = params.toString();

	return `/api/wp/submitted-tests/export${query ? `?${query}` : ""}`;
}

/**
 * The monthly statement (PRD § 6.12): every test the current filters match,
 * across every page, as a CSV file.
 *
 * Fetched, not linked. A plain `<a download>` hands a refusal — "more than
 * 5,000 tests match", or a session that has expired — to the browser's
 * download bar as a failed file. Fetching first lets the screen say what went
 * wrong, under the button, in the server's own words.
 */
export function SubmittedTestsExportButton({
	filters,
	disabled,
}: {
	filters: ExportFilters;
	/** The filters are not a question the server can answer, or nothing matched. */
	disabled: boolean;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function download() {
		setPending(true);
		setError(null);

		try {
			const response = await fetch(exportUrl(filters));

			if (!response.ok) {
				setError((await response.text()) || "The export failed. Try again.");
				return;
			}

			const fileName =
				/filename="([^"]+)"/.exec(
					response.headers.get("content-disposition") ?? "",
				)?.[1] ?? "submitted-tests.csv";
			const href = URL.createObjectURL(await response.blob());
			const link = document.createElement("a");
			link.href = href;
			link.download = fileName;
			link.click();
			URL.revokeObjectURL(href);
		} catch {
			setError("The export failed. Check your connection and try again.");
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="flex flex-col items-end gap-1.5">
			<Button
				variant="secondary"
				size="sm"
				disabled={disabled || pending}
				onClick={download}
				title="Downloads every test these filters match, not only this page"
			>
				{pending ? (
					<LoaderCircle className="animate-spin" aria-hidden />
				) : (
					<Download aria-hidden />
				)}
				Download CSV
			</Button>
			{error ? (
				<p
					role="alert"
					className="max-w-[320px] text-right text-[12px] text-danger"
				>
					{error}
				</p>
			) : null}
		</div>
	);
}
