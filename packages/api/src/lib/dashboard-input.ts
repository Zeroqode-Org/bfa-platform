import { z } from "zod";

/**
 * Input shapes for the WP dashboard's procedures.
 *
 * There is deliberately very little here. A dashboard is a fixed set of
 * answers to a fixed set of questions, not a reporting tool — so the only
 * thing a client gets to choose is the pass/fail window and how many rows the
 * two home lists show. Everything else is decided by the server: the tenant
 * from `ctx.caller.waterPurveyorId`, the month from the calendar, the trend's
 * twelve months from `dashboard-calendar`.
 *
 * `water_purveyor_id` is absent from every shape below, and its absence is the
 * authorization story rather than a convenience. A client that sends one is
 * sending a field the server does not read — the same rule
 * `submission-input.ts` states for the submitted-test procedures.
 *
 * Separate from `routers/dashboard.ts` for the reason `asset-input.ts` gives:
 * that file imports `@bfa-platform/db`, and importing a Postgres connection to
 * assert that a date range runs forwards would make a pure rule need a
 * database.
 */

/** How many rows the two home lists show unless the screen asks for fewer. */
export const HOME_LIST_DEFAULT_LIMIT = 5;

/** The ceiling on either home list. Past it, the reader wants the full table. */
export const HOME_LIST_MAX_LIMIT = 20;

/**
 * One of the two short home lists.
 *
 * A limit and nothing else — no filters, no sort, no paging. Both lists are
 * previews that exist to be clicked out of: incoming reports open the
 * Submitted Tests document, delinquent assets open the asset. The screens that
 * answer "and the rest?" already exist and are one click away, so giving this
 * one a second, slightly different filter surface would mean maintaining two.
 */
export const homeListInput = z
	.object({
		limit: z
			.number()
			.int()
			.min(1)
			.max(HOME_LIST_MAX_LIMIT)
			.default(HOME_LIST_DEFAULT_LIMIT),
	})
	// `prefault`, not `default`: an absent input parses as `{}` and picks up the
	// field's own default, rather than restating it here where it could drift.
	.prefault({});

/**
 * The pass/fail breakdown's window.
 *
 * Both bounds required, both inclusive, and nothing else. The build plan asks
 * for "counts by result over a selectable range" (§ 6.4.3) — a result filter
 * on a chart whose two bars *are* the results would be a control that can only
 * delete half its own output, and a certifier or BIN filter would be
 * re-implementing the Submitted Tests screen inside a card.
 *
 * Required rather than optional because a chart has to say what it is counting.
 * An unbounded default would render a number whose meaning changes with the
 * age of the database, and the visible date inputs would then start out
 * disagreeing with what is on screen.
 *
 * A range that ends before it starts is a typo, not an empty result. Saying so
 * beats returning two zeroes and letting the reader conclude nobody tested
 * anything that month — the same reasoning, and the same wording, as
 * `listSubmittedTestsInput`.
 */
export const passFailBreakdownInput = z
	.strictObject({
		/** Inclusive lower bound on `test_date`. */
		from: z.iso.date(),
		/** Inclusive upper bound on `test_date`. */
		to: z.iso.date(),
	})
	.refine((value) => value.from <= value.to, {
		message: "The end of the range comes before its start",
		path: ["to"],
	});

export type HomeListInput = z.infer<typeof homeListInput>;
export type PassFailBreakdownInput = z.infer<typeof passFailBreakdownInput>;
