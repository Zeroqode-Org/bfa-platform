import type { Caller } from "@bfa-platform/api/context";

/**
 * Short, human role names for the shell chrome.
 *
 * Deliberately shorter than the invite screen's labels ("Water Purveyor
 * Administrator"): those introduce a role to somebody who has never seen it,
 * these sit under a name in a 216px sidebar and only have to answer "which
 * kind of account is this".
 */
const ROLE_LABELS: Record<Caller["globalRole"], string> = {
	super_admin: "Super Admin",
	wp_admin: "WP Administrator",
	wp_sub_admin: "WP Sub-Administrator",
	wp_employee: "WP Employee",
	certifier: "Certifier",
};

export function roleLabel(role: Caller["globalRole"]): string {
	return ROLE_LABELS[role];
}
