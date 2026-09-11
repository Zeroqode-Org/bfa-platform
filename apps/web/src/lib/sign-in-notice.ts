import type { CallerRefusal } from "@bfa-platform/api/caller-refusal";
import type { Route } from "next";

/**
 * What the sign-in screen says when a session is valid but the account behind
 * it is not usable.
 *
 * Signing in as a blocked certifier used to succeed and then bounce straight
 * back to an empty sign-in form. Supabase Auth accepts the password — blocking
 * writes `certifiers.status`, not anything in `auth.users` — so the only signal
 * was a form that had apparently cleared itself. That reads as a typo, and the
 * person retypes a password that was right the first time.
 *
 * The route gate now names the reason in the URL and this module turns it into
 * copy, so the screen says what happened.
 */
export type SignInNotice = {
	/** Which token pair the block is painted in. */
	tone: "danger" | "warning";
	title: string;
	description: string;
};

/** The query parameter that carries a refusal to the sign-in screen. */
export const SIGN_IN_NOTICE_PARAM = "notice";

const NOTICES: Record<CallerRefusal, SignInNotice> = {
	/**
	 * Deliberately does not say *who* blocked them or which switch was thrown.
	 * A certifier can be blocked by any water purveyor that authorized them, and
	 * naming the one that did it would tell a certifier working for three
	 * purveyors something about a tenant that is not theirs to know. "Whoever
	 * you work with" covers both switches without disclosing either.
	 */
	blocked: {
		tone: "danger",
		title: "This account is blocked.",
		description:
			"Your password is correct, but the account has been switched off, so there is nothing to open. A water purveyor you work with, or the platform administrator, can lift it — contact them to get access back.",
	},
	/**
	 * An `auth.users` row with no `profiles` row: an invitation whose redemption
	 * created the credentials and then failed. Rare, and it needs a different
	 * answer from a block — a new invite link, not a conversation.
	 */
	no_profile: {
		tone: "warning",
		title: "This account was never finished.",
		description:
			"Your sign-in works, but the setup behind it did not complete. Ask whoever invited you to send a new invitation link.",
	},
};

/** Where a gate sends somebody whose session resolved to a refusal. */
export function signInNoticeRoute(refusal: CallerRefusal): Route {
	return `/login?${SIGN_IN_NOTICE_PARAM}=${refusal}` as Route;
}

/**
 * The notice for a raw query value, or null.
 *
 * Takes the query shape Next hands over — a string, a repeated parameter, or
 * nothing — and answers null for anything unrecognised, so a hand-typed
 * `?notice=whatever` renders no banner rather than an empty one. Nothing from
 * the URL is ever displayed; the value only selects between the fixed copy
 * above.
 */
export function signInNoticeFor(
	value: string | string[] | undefined,
): SignInNotice | null {
	const key = Array.isArray(value) ? value[0] : value;

	if (!key) return null;

	// `Object.hasOwn`, not `NOTICES[key] ?? null`. A plain lookup walks the
	// prototype chain, so `?notice=__proto__` answers with `Object.prototype`
	// and `?notice=toString` with a function — both truthy, and both would put
	// a banner on the screen with an undefined title in it.
	return Object.hasOwn(NOTICES, key) ? NOTICES[key as CallerRefusal] : null;
}

/**
 * Where a failed tRPC call should send the browser, or null if it was an
 * ordinary failure.
 *
 * The gates cover a page load. This covers the other half: a certifier already
 * sitting on a screen when a purveyor blocks them, whose next query or mutation
 * comes back refused. Without it they get a toast reading "Account blocked" on
 * a page that still looks signed in, and no way to make sense of it.
 *
 * Reads `data.refusal`, which the API's error formatter puts there — not the
 * message, and not the `FORBIDDEN` code, which every ordinary permission error
 * also carries and which must *not* throw somebody out to the sign-in screen.
 */
export function signInNoticeRedirectFor(error: unknown): Route | null {
	const data = (error as { data?: unknown } | null | undefined)?.data;
	const refusal = (data as { refusal?: unknown } | null | undefined)?.refusal;

	return typeof refusal === "string" && Object.hasOwn(NOTICES, refusal)
		? signInNoticeRoute(refusal as CallerRefusal)
		: null;
}
