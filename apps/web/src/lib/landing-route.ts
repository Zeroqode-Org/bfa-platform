import type { Route } from "next";

/**
 * Where each role lives.
 *
 * One table, because three different places need the answer — the `/` redirect
 * after sign-in, the invite-redemption action, and the role gate that bounces
 * somebody out of a section they cannot see. Three copies of a switch is three
 * chances for a role to be sent somewhere it does not belong.
 */
export type LandingRole =
	| "super_admin"
	| "wp_admin"
	| "wp_sub_admin"
	| "wp_employee"
	| "certifier";

export function landingRouteFor(role: LandingRole): Route {
	switch (role) {
		case "super_admin":
			return "/admin";
		case "certifier":
			// Drafts, not the wizard: the dashboard is the list of work in
			// progress, and starting a fresh wizard is a decision, not a landing.
			return "/certifier/drafts";
		default:
			// All three WP roles share one dashboard; what differs between them is
			// what the procedures behind it allow, not which screen they open.
			return "/wp";
	}
}
