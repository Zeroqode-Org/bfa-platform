"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { FileDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * Opens a test's result PDF in a new tab.
 *
 * The tab is opened *before* the link is fetched and pointed at it afterwards:
 * phones (iOS Safari above all) block a `window.open` that happens after an
 * `await`, because by then it no longer counts as the tap's own doing.
 */
export function ResultDocumentButton({
	fetchUrl,
	className,
}: {
	/** Resolves to a short-lived signed link to the PDF. */
	fetchUrl: () => Promise<string>;
	className?: string;
}) {
	const [pending, setPending] = useState(false);

	async function open() {
		const tab = window.open("", "_blank");
		setPending(true);

		try {
			const url = await fetchUrl();

			if (tab) tab.location.href = url;
			else window.location.href = url;
		} catch (error) {
			tab?.close();
			toast.error(
				error instanceof Error ? error.message : "Could not open the PDF",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<Button
			type="button"
			variant="secondary"
			size="sm"
			className={className}
			disabled={pending}
			onClick={open}
		>
			{pending ? (
				<LoaderCircle className="animate-spin" aria-hidden="true" />
			) : (
				<FileDown aria-hidden="true" />
			)}
			{pending ? "Preparing PDF…" : "Download PDF"}
		</Button>
	);
}
