import { cn } from "@bfa-platform/ui/lib/utils";
import { Ban, TriangleAlert } from "lucide-react";

import type { SignInNotice as Notice } from "@/lib/sign-in-notice";

/**
 * The banner above the sign-in form explaining why a previous attempt got
 * nowhere.
 *
 * `role="status"` rather than `role="alert"`: this renders on page load, not in
 * response to something the person just did. An alert interrupts; a status is
 * announced in turn, which is what a page they have just arrived on should do.
 * The form's own submit errors stay `role="alert"`, because those *are* a
 * response to an action.
 *
 * Tokens only — the tint pairs from the design system, never a solid fill.
 */
export function SignInNotice({ notice }: { notice: Notice }) {
	const Icon = notice.tone === "danger" ? Ban : TriangleAlert;

	return (
		<div
			role="status"
			className={cn(
				"mt-4 flex items-start gap-2 rounded-md px-3 py-2.5 text-[13px]",
				notice.tone === "danger"
					? "bg-danger-bg text-danger"
					: "bg-warning-bg text-warning",
			)}
		>
			<Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<p>
				<strong className="font-semibold">{notice.title}</strong>{" "}
				{notice.description}
			</p>
		</div>
	);
}
