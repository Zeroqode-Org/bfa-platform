import { createContext } from "@bfa-platform/api/context";
import {
	statementCsv,
	statementFileName,
} from "@bfa-platform/api/lib/statement-columns";
import { appRouter } from "@bfa-platform/api/routers/index";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import type { NextRequest } from "next/server";

/**
 * The monthly statement as a CSV file (PRD § 6.12): every submitted test the
 * Submitted Tests screen's filters match, across all its pages.
 *
 * A plain route rather than a tRPC call because the answer is a file, with a
 * file name, for the browser to save. It is only plumbing around
 * `submittedTests.exportSubmittedTests`, called through `createCaller` with the
 * same context the tRPC route builds — so the session check, impersonation,
 * `wpProcedure`'s role and tenant scoping, the input rules and the audit line
 * are that procedure's, and there is no second copy of any of them here.
 *
 * GET, and therefore outside the tRPC route's same-origin check, which guards
 * writes. This writes nothing: it reads the caller's own rows back to them.
 */
export async function GET(req: NextRequest) {
	const resHeaders = new Headers();

	try {
		const ctx = await createContext({
			req,
			resHeaders,
			info: undefined as never,
		});
		// Every query parameter goes to the procedure, known or not — its input
		// is strict, so a misspelt bound is refused rather than silently widening
		// the statement.
		const input = Object.fromEntries(req.nextUrl.searchParams);
		const rows = await appRouter
			.createCaller(ctx)
			.submittedTests.exportSubmittedTests(input);

		resHeaders.set("content-type", "text/csv; charset=utf-8");
		resHeaders.set(
			"content-disposition",
			`attachment; filename="${statementFileName(input)}"`,
		);
		resHeaders.set("cache-control", "no-store");

		return new Response(statementCsv(rows), {
			status: 200,
			headers: resHeaders,
		});
	} catch (error) {
		const trpcError =
			error instanceof TRPCError
				? error
				: new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });

		if (trpcError.code === "INTERNAL_SERVER_ERROR") {
			console.error(
				JSON.stringify({
					event: "submitted_tests_export_failed",
					message: String(trpcError.cause ?? trpcError.message),
					timestamp: new Date().toISOString(),
				}),
			);
		}

		resHeaders.set("content-type", "text/plain; charset=utf-8");
		resHeaders.set("cache-control", "no-store");

		// The procedure's own words for anything it refused on purpose — they are
		// written for the reader. An unexpected failure says nothing about why.
		return new Response(
			trpcError.code === "INTERNAL_SERVER_ERROR"
				? "The export failed. Try again."
				: trpcError.message,
			{ status: getHTTPStatusCodeFromError(trpcError), headers: resHeaders },
		);
	}
}
