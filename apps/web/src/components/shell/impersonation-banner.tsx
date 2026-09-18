"use client";

import {
	type ImpersonationState,
	useEndImpersonation,
} from "@/lib/use-impersonation";

/**
 * Full-width warning bar shown while a Super-Admin is impersonating a water
 * purveyor. Always visible above the shell, never dismissable and never
 * collapsed into a menu (design system rule) — ending the impersonation is the
 * only way to remove it.
 *
 * The state comes from the server route gate, not from the browser: the shell
 * passes it in, so the bar is in the first paint of every impersonated page and
 * cannot be switched off by anything short of the server clearing the cookie.
 */
export function ImpersonationBanner({
	impersonation,
}: {
	impersonation: ImpersonationState | null | undefined;
}) {
	if (!impersonation) return null;

	return <ActiveImpersonationBanner impersonation={impersonation} />;
}

/**
 * Split out so the mutation hook only mounts while impersonating — every
 * dashboard page renders the outer component, most of them with nothing to show.
 */
function ActiveImpersonationBanner({
	impersonation,
}: {
	impersonation: ImpersonationState;
}) {
	const end = useEndImpersonation();
	// Still busy once the mutation succeeds: the page is about to be replaced.
	const exiting = end.isPending || end.isSuccess;

	return (
		<section
			aria-label="Impersonation"
			className="flex w-full shrink-0 items-center justify-center gap-2.5 overflow-x-auto whitespace-nowrap border-warning/30 border-b bg-impersonation-bg px-4 py-2.5 text-impersonation-text"
		>
			<span className="font-semibold text-[13.5px]">
				Viewing as {impersonation.waterPurveyorName}
			</span>
			<button
				type="button"
				onClick={() => end.mutate()}
				disabled={exiting}
				aria-busy={exiting}
				className="shrink-0 rounded-sm font-semibold text-[13px] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
			>
				{exiting ? "Exiting impersonation…" : "Exit impersonation"}
			</button>
		</section>
	);
}
