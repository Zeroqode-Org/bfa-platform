"use client";

import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@bfa-platform/ui/components/dialog";
import { ResultDocumentButton } from "@/components/result-document-button";

/**
 * The pop-up after both Submit and Save to Draft (build-plan § 6.5 step 24;
 * confirmed in the Asana spec for both paths). Two actions only: start a
 * fresh test against the same active WP, or return to the dashboard.
 */
export function CompletionDialog({
	open,
	kind,
	onDoAnother,
	onExit,
	onDismiss,
	fetchPdfUrl,
}: {
	open: boolean;
	kind: "submitted" | "saved" | null;
	onDoAnother: () => void;
	onExit: () => void;
	/** The X / Escape: closes the pop-up and leaves the certifier where they are. */
	onDismiss: () => void;
	/** Present after a submit: resolves to the link to that test's PDF. */
	fetchPdfUrl?: () => Promise<string>;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onDismiss();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{kind === "submitted" ? "Test submitted" : "Draft saved"}
					</DialogTitle>
					<DialogDescription>
						{kind === "submitted"
							? "The result document has been generated and sent to the water purveyor, the customer, and you."
							: "Your progress has been saved. You can resume this test from Drafts at any time."}
					</DialogDescription>
				</DialogHeader>
				{kind === "submitted" && fetchPdfUrl ? (
					<ResultDocumentButton fetchUrl={fetchPdfUrl} className="self-start" />
				) : null}
				<DialogFooter>
					<Button variant="secondary" onClick={onExit}>
						Exit
					</Button>
					<Button onClick={onDoAnother}>Do Another Test</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
