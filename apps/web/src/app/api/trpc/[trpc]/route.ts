import { createContext } from "@bfa-platform/api/context";
import { appRouter } from "@bfa-platform/api/routers/index";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { checkSameOrigin } from "@/lib/same-origin";

function handler(req: NextRequest) {
	return fetchRequestHandler({
		endpoint: "/api/trpc",
		req,
		router: appRouter,
		createContext: (opts) => createContext(opts),
	});
}

/**
 * Every tRPC POST — every mutation, and every batched call — must come from this
 * app's own origin. Checked here, before `fetchRequestHandler`, so a forged
 * request is refused before tRPC creates a context: no Supabase session is read
 * or refreshed, no impersonation cookie is resolved, and no procedure runs.
 * There are no exceptions, public procedures such as
 * `session.clearImpersonation` included.
 *
 * The refusal is a bare 403 that says nothing about why, and its log line names
 * only the reason and the path — never the Origin value, cookies or body.
 */
async function POST(req: NextRequest) {
	const check = checkSameOrigin(req);

	if (!check.ok) {
		console.log(
			JSON.stringify({
				event: "csrf_request_rejected",
				reason: check.reason,
				method: req.method,
				path: new URL(req.url).pathname,
				timestamp: new Date().toISOString(),
			}),
		);

		return new Response("Forbidden", {
			status: 403,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}

	return handler(req);
}

// GET carries queries only — tRPC refuses a mutation over GET — so it is left
// exactly as it was.
export { handler as GET, POST };
