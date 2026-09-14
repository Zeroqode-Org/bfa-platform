/**
 * Not product rules. `subject` and `body` are Postgres `text` and neither the
 * PRD nor the build plan puts a ceiling on either; these are input hygiene —
 * wide enough that no real notice meets them, narrow enough that a pasted
 * document does not become a row or an email.
 *
 * A module of its own, importing nothing, so the notice editor and the
 * broadcast composer can show the same limits inline (and count against them)
 * without pulling Zod into the browser bundle through `notice-input.ts`.
 */
export const NOTICE_FIELD_LIMITS = {
	subject: 200,
	body: 5000,
} as const;
