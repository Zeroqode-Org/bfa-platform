/**
 * Server-side same-origin check for state-changing requests.
 *
 * The session and impersonation cookies are `SameSite=Lax`, which already keeps
 * them off most cross-site POSTs. This is the second, independent defence: a
 * POST is accepted only when the browser's `Origin` header names exactly the
 * origin the request was sent to. Browsers set `Origin` on every cross-origin
 * request and on same-origin POSTs, and page script cannot forge it.
 *
 * The expected origin comes from the incoming request URL alone — never from
 * configuration a client could influence, never an allow-list, never a
 * wildcard, substring or hostname-only comparison. Scheme, host and port must
 * all match. Next builds the request URL from the `Host` header and
 * `X-Forwarded-Proto`, so a reverse proxy in front of the app must forward both
 * unchanged.
 *
 * Pure and dependency-free: no cookies, no body, no session is touched.
 */

export type OriginRejection =
	/** No `Origin` header, or an empty one. */
	| "missing_origin"
	/** Not exactly a serialized http(s) origin — `null`, a path, credentials… */
	| "malformed_origin"
	/** A well-formed origin that is not this request's. */
	| "cross_origin";

export type OriginCheck = { ok: true } | { ok: false; reason: OriginRejection };

export function checkSameOrigin(request: Request): OriginCheck {
	const origin = request.headers.get("origin");
	if (!origin) return { ok: false, reason: "missing_origin" };

	let claimed: URL;
	try {
		claimed = new URL(origin);
	} catch {
		return { ok: false, reason: "malformed_origin" };
	}

	// A real `Origin` header is exactly `scheme://host[:port]`. Re-serializing and
	// comparing byte-for-byte rejects anything carrying a path, a trailing slash,
	// a query, credentials or odd casing, rather than silently normalizing it
	// into something that happens to match.
	if (
		(claimed.protocol !== "https:" && claimed.protocol !== "http:") ||
		claimed.origin !== origin
	) {
		return { ok: false, reason: "malformed_origin" };
	}

	return claimed.origin === new URL(request.url).origin
		? { ok: true }
		: { ok: false, reason: "cross_origin" };
}
