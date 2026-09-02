"use client";

import { useImpersonation } from "@/lib/use-impersonation";

/**
 * Full-width warning bar shown while a Super-Admin is impersonating a WP or
 * certifier. Always visible, never collapsed into a menu (design system rule).
 */
export function ImpersonationBanner() {
	const state = useImpersonation();
	if (!state.isImpersonating) return null;

	return (
		<div className="flex w-full items-center justify-center gap-2 bg-impersonation-bg px-4 py-2 text-[13px] text-impersonation-text">
			<span>
				Viewing as{" "}
				<strong className="font-semibold">{state.companyName}</strong>
			</span>
			<button type="button" className="underline underline-offset-2">
				Exit impersonation
			</button>
		</div>
	);
}
