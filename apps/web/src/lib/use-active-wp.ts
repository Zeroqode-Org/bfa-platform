"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { trpc } from "@/utils/trpc";

/**
 * The water purveyor a certifier is currently working under (§ 6.4). A
 * certifier can be authorized by several WPs; the wizard and dashboards run
 * against the active one, and switching re-filters everything rather than
 * merging — `certifier.listDrafts`/`listSubmissions`/`getDraft`/`deleteDraft`
 * all take the active WP as an input and validate it server-side.
 *
 * `list` comes from `certifier.listAuthorizedWps` — real data, the caller's
 * own `active` authorizations only. The selection itself is a module-level
 * store, same shape the mock version used, so every `<WpSwitcher />` instance
 * (mobile and desktop headers) stays in sync without prop drilling — but it
 * is seeded from `sessionStorage` rather than always defaulting to the first
 * WP, and it holds nothing until the query actually resolves.
 *
 * Deliberately client-only, per the build-plan's own wording ("persists the
 * selection in client state for the session") — no cookie, no server
 * resolution. `use-impersonation.ts` documents a *later* week replacing its
 * own mock with a signed httpOnly cookie; nothing here asks for that.
 */
export type WaterPurveyor = { id: string; name: string };

const STORAGE_KEY = "bfa-certifier-active-wp-id";

let activeId: string | null = null;
const listeners = new Set<() => void>();

function readStoredId(): string | null {
	try {
		return sessionStorage.getItem(STORAGE_KEY);
	} catch {
		// Private browsing, or storage disabled — the selection still works
		// for this load, it just starts from the first authorized WP instead
		// of a remembered one.
		return null;
	}
}

function setActiveWp(id: string) {
	if (id === activeId) return;
	activeId = id;
	try {
		sessionStorage.setItem(STORAGE_KEY, id);
	} catch {
		// Same as above: persistence is a nicety, not a requirement.
	}
	for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

function getSnapshot() {
	return activeId;
}

function getServerSnapshot() {
	return null;
}

export function useActiveWp() {
	const wps = useQuery(trpc.certifier.listAuthorizedWps.queryOptions());
	const list = wps.data ?? [];

	const storedId = useSyncExternalStore(
		subscribe,
		getSnapshot,
		getServerSnapshot,
	);

	// Adopts an initial selection once the list actually lands: the
	// `sessionStorage` choice if it is still one of the caller's active
	// authorizations, else the first WP. An effect, not something computed
	// during render — it writes to the shared module store, and doing that
	// mid-render would tell React the store changed while still rendering
	// from the old value. Runs once per store lifetime (`activeId` starts
	// `null` and this only fires while it still is), matching how the store
	// otherwise only changes through an explicit `setActiveWp` call.
	useEffect(() => {
		if (activeId || list.length === 0) return;

		const stored = readStoredId();
		const initial = list.find((wp) => wp.id === stored) ?? list[0];

		if (initial) setActiveWp(initial.id);
	}, [list]);

	const active = list.find((wp) => wp.id === storedId);

	return {
		active,
		list,
		setActiveWp,
		isLoading: wps.isPending,
		isError: wps.isError,
	};
}
