import type { Route } from "next";

/**
 * A full browser navigation, not a router transition.
 *
 * Used where the identity behind the page changes — starting or ending an
 * impersonation. A full load runs the server route gates against the new
 * cookie, and throws away a React Query cache and a router cache full of data
 * that belonged to the previous identity. Its own module so component tests can
 * replace it; jsdom's `location.assign` cannot be spied on.
 */
export function hardNavigate(route: Route) {
	window.location.assign(route);
}
