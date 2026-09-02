"use client";

/**
 * Stub for the Super-Admin impersonation state. The real implementation (Week 4)
 * reads a signed, httpOnly cookie set by the `startImpersonation` procedure and
 * resolves the effective identity through the shared tRPC context helper.
 *
 * For now this always reports "not impersonating"; flip the return value to test
 * the banner. Keeping it as a hook means shells can consume it today without
 * changing when the real source lands.
 */
export type ImpersonationState =
	| { isImpersonating: false }
	| { isImpersonating: true; companyName: string };

export function useImpersonation(): ImpersonationState {
	return { isImpersonating: false };
}
