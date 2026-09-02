"use client";

import { useSyncExternalStore } from "react";

/**
 * The water purveyor a certifier is currently working under. A certifier can be
 * authorized by several WPs; the wizard and dashboards run against the active
 * one. Real version (Week 2+) comes from a tRPC `certifier.listAuthorizedWps`
 * query plus an active-WP cookie resolved in the caller context. For now it's a
 * module-level store so every `<WpSwitcher />` instance stays in sync.
 */
export type WaterPurveyor = { id: string; name: string };

const WP_A: WaterPurveyor = { id: "wp-a", name: "Water Purveyor A" };

const MOCK_WPS: WaterPurveyor[] = [
	WP_A,
	{ id: "wp-b", name: "Water Purveyor B" },
	{ id: "wp-c", name: "Water Purveyor C" },
];

let activeId = WP_A.id;
const listeners = new Set<() => void>();

function setActiveWp(id: string) {
	if (id === activeId) return;
	activeId = id;
	for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

export function useActiveWp() {
	const id = useSyncExternalStore(
		subscribe,
		() => activeId,
		() => WP_A.id,
	);
	const active = MOCK_WPS.find((wp) => wp.id === id) ?? WP_A;
	return { active, list: MOCK_WPS, setActiveWp };
}
