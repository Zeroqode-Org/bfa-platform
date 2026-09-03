"use client";

import { useSyncExternalStore } from "react";

/**
 * Super-Admin impersonation state.
 *
 * Week 1 is UI only: this is a module-level demo store, so clicking
 * "Impersonate" in the water-purveyor list shows the banner and "Exit
 * impersonation" clears it, with no auth or navigation behind it.
 *
 * Week 4 replaces the source — a signed, httpOnly cookie set by the
 * `startImpersonation` procedure, resolved through the shared tRPC context
 * helper. `ImpersonationState` and `useImpersonation()` keep their shape, so
 * no consumer changes.
 */
export type ImpersonationState =
	| { isImpersonating: false }
	| { isImpersonating: true; companyName: string };

const NOT_IMPERSONATING: ImpersonationState = { isImpersonating: false };

let state: ImpersonationState = NOT_IMPERSONATING;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

/** Demo-only: enter the impersonated state for `companyName`. */
export function impersonate(companyName: string) {
	state = { isImpersonating: true, companyName };
	emit();
}

/** Demo-only: leave the impersonated state. The banner's only exit. */
export function exitImpersonation() {
	if (!state.isImpersonating) return;
	state = NOT_IMPERSONATING;
	emit();
}

function subscribe(onChange: () => void) {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

export function useImpersonation(): ImpersonationState {
	return useSyncExternalStore(
		subscribe,
		() => state,
		() => NOT_IMPERSONATING,
	);
}
