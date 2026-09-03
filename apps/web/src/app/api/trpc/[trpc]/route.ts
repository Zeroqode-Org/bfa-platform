import { createContext } from "@bfa-platform/api/context";
import { appRouter } from "@bfa-platform/api/routers/index";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

function handler(req: NextRequest) {
	return fetchRequestHandler({
		endpoint: "/api/trpc",
		req,
		router: appRouter,
		createContext: (opts) => createContext(opts),
	});
}

export { handler as GET, handler as POST };
