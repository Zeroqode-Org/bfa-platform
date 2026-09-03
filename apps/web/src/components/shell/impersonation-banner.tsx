"use client";

import { exitImpersonation, useImpersonation } from "@/lib/use-impersonation";

/**
 * Full-width warning bar shown while a Super-Admin is impersonating a WP or
 * certifier. Always visible above the shell, never dismissable and never
 * collapsed into a menu (design system rule) — ending the impersonation is the
 * only way to remove it.
 */
export function ImpersonationBanner() {
	const state = useImpersonation();
	if (!state.isImpersonating) return null;

	return (
		<div className="flex w-full shrink-0 items-center justify-center gap-2.5 overflow-x-auto whitespace-nowrap border-warning/30 border-b bg-impersonation-bg px-4 py-2.5 text-impersonation-text">
			<span className="font-semibold text-[13.5px]">
				Viewing as {state.companyName}
			</span>
			<button
				type="button"
				onClick={exitImpersonation}
				className="shrink-0 rounded-sm font-semibold text-[13px] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				Exit impersonation
			</button>
		</div>
	);
}
