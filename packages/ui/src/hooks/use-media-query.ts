"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * SSR-safe media-query hook. Returns `false` during server render and the first
 * client paint, then the real match after hydration — so components that swap
 * layout on a breakpoint (e.g. the certifier sidebar vs. bottom tab bar) never
 * cause a hydration mismatch. Render the mobile/default branch for `false`.
 */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (typeof window === "undefined") return () => {};
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);

	const getSnapshot = useCallback(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia(query).matches;
	}, [query]);

	const getServerSnapshot = () => false;

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Matches the design system's certifier desktop breakpoint (>= 780px). */
export function useIsDesktop(): boolean {
	return useMediaQuery("(min-width: 780px)");
}
