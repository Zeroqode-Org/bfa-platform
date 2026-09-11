import { TRPCError } from "@trpc/server";

/**
 * Why `resolveCaller` refused a session that Supabase Auth itself accepted.
 *
 * Deliberately its own module rather than part of `context.ts`. The sign-in
 * screen has to read this vocabulary to explain itself, and `context.ts`
 * imports the Drizzle connection — so pulling the refusal type in from a route
 * gate, or from a test, would drag a database handle and its required
 * environment along with it. Nothing here needs either.
 *
 * `context.ts` re-exports all three, so existing import sites are unaffected.
 */
export type CallerRefusal =
	/** The account is switched off — `profiles.status` or `certifiers.status`. */
	| "blocked"
	/** Signed in, but no `profiles` row: a redemption that never completed. */
	| "no_profile";

/**
 * A refusal from `resolveCaller`, carrying the reason as a value.
 *
 * Both cases look identical from the browser — correct password, then nothing —
 * so the sign-in screen has to tell them apart to say anything useful. It
 * branches on `refusal` rather than on the message: the wording is copy and
 * will be rewritten, and matching on it would move the screen's behaviour
 * silently the day somebody edits a sentence.
 *
 * Still a `TRPCError`, so every procedure keeps returning a proper `FORBIDDEN`
 * and nothing downstream needs to know this subclass exists.
 */
export class CallerRefusedError extends TRPCError {
	readonly refusal: CallerRefusal;

	constructor(refusal: CallerRefusal, message: string) {
		super({ code: "FORBIDDEN", message });
		this.name = "CallerRefusedError";
		this.refusal = refusal;
	}
}

/** The refusal behind an error, or null when it did not come from here. */
export function callerRefusal(error: unknown): CallerRefusal | null {
	return error instanceof CallerRefusedError ? error.refusal : null;
}

/**
 * The extra fields a refusal contributes to a tRPC error's `data`, so the
 * browser can act on the reason rather than parse the message.
 *
 * `cause` is checked as well as the error itself. A `TRPCError` thrown from a
 * procedure arrives here unwrapped, but anything that reaches tRPC by another
 * route is wrapped with the original hung off `cause`, and a refusal that
 * stopped being recognisable because of where it was thrown would strand the
 * browser on a toast.
 */
export function refusalErrorData(
	error: unknown,
): { refusal: CallerRefusal } | null {
	const refusal =
		callerRefusal(error) ??
		callerRefusal((error as { cause?: unknown } | null)?.cause);

	return refusal ? { refusal } : null;
}
