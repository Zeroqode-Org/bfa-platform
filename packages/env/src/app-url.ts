/**
 * The absolute base URL server-side code puts in links it sends to people —
 * invitation links in outbound mail, first of all.
 *
 * Resolved from configuration only, in this order:
 *
 * 1. `APP_URL` — an explicit, portable override: Docker, any other host, or a
 *    Vercel project that wants a domain other than its production one.
 * 2. `NEXT_PUBLIC_APP_URL` — legacy. Read before this module existed, and kept
 *    so an environment that already sets it keeps its links. New configuration
 *    uses `APP_URL`; this fallback is temporary.
 * 3. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel's system variable holding the
 *    project's production domain as a bare hostname, so it follows a domain
 *    change without a redeploy of configuration. `https://` is added here.
 * 4. `http://localhost:3001` — only when none is set, so a fresh clone prints
 *    a link a developer can click. The port matches `apps/web`'s dev server.
 *
 * Deliberately not consulted:
 *
 * - `VERCEL_URL` is the URL of one deployment, preview deployments included. A
 *   production email pointing there sends people to a build that may be stale or
 *   behind Vercel's deployment protection.
 * - Request headers (`Host`, `X-Forwarded-Host`). Whoever sends the request
 *   chooses them, which makes a link built from them a host-header injection,
 *   and background work has no request to read them from anyway.
 * - Any other `NEXT_PUBLIC_*`. This is server configuration and has no reason
 *   to be inlined into a browser bundle; `NEXT_PUBLIC_APP_URL` is read only for
 *   backward compatibility, from the server's `process.env`.
 *
 * A value that is set but unusable throws rather than falling through to the
 * next source: a deployment that meant to configure its domain and got it wrong
 * should stop, not quietly mail out localhost or a scheme nobody should click.
 *
 * Pure — it reads only the `source` it is given — so the env schema in
 * `server.ts` and the link builders share one definition of a valid base URL.
 */

export const LOCAL_APP_URL = "http://localhost:3001";

/**
 * `process.env` or anything shaped like it. The index signature lets a
 * `ProcessEnv` that Next's types have narrowed to declared keys be passed as is.
 */
export type AppUrlSource = {
	APP_URL?: string | undefined;
	NEXT_PUBLIC_APP_URL?: string | undefined;
	VERCEL_PROJECT_PRODUCTION_URL?: string | undefined;
	[key: string]: string | undefined;
};

/** `undefined` for a missing, empty or whitespace-only value. */
function configured(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Validates an absolute `http:` / `https:` base URL and returns it without a
 * trailing slash. Throws a message naming `name` otherwise.
 */
export function normalizeAppUrl(value: string, name = "APP_URL"): string {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		throw new Error(
			`${name} must be an absolute http(s) URL such as https://app.example.com.`,
		);
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`${name} must use http: or https:, not ${url.protocol}`);
	}

	if (!url.hostname) {
		throw new Error(`${name} must include a hostname.`);
	}

	// A base URL is prepended to paths. Credentials would ride along in every
	// link, and a query or fragment would swallow the path appended after it.
	if (url.username || url.password) {
		throw new Error(`${name} must not contain credentials.`);
	}

	if (url.search || url.hash) {
		throw new Error(`${name} must not contain a query string or fragment.`);
	}

	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` to a hostname with no scheme. A
 * value carrying a scheme, path or anything else is not what Vercel sends and
 * is refused rather than reinterpreted.
 */
export function normalizeVercelProductionUrl(value: string): string {
	const name = "VERCEL_PROJECT_PRODUCTION_URL";

	if (!/^[a-z0-9.-]+(:\d+)?$/i.test(value)) {
		throw new Error(
			`${name} must be a bare hostname such as app.example.com, as Vercel provides it.`,
		);
	}

	return normalizeAppUrl(`https://${value}`, name);
}

export function resolveAppBaseUrl(source: AppUrlSource): string {
	const appUrl = configured(source.APP_URL);
	if (appUrl) return normalizeAppUrl(appUrl);

	const legacyAppUrl = configured(source.NEXT_PUBLIC_APP_URL);
	if (legacyAppUrl) return normalizeAppUrl(legacyAppUrl, "NEXT_PUBLIC_APP_URL");

	const vercelProductionUrl = configured(source.VERCEL_PROJECT_PRODUCTION_URL);
	if (vercelProductionUrl) {
		return normalizeVercelProductionUrl(vercelProductionUrl);
	}

	return LOCAL_APP_URL;
}
