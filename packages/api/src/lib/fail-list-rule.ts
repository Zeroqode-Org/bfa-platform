/**
 * When an unresolved failure reaches the fail list.
 *
 * The product rule (PRD § 6.8, flow 5 "Failure to repair"): a failed test
 * triggers the failure email immediately, and the asset appears on the WP's
 * fail list only after **30 days without a passing re-test**. A later
 * submitted pass clears it at once, whether or not it had appeared yet. The
 * platform does not track whether a repair happened — only whether a passing
 * test has been filed since.
 *
 * Imports nothing, so the boundary arithmetic is unit-testable without a
 * database. `dashboard.failList` passes the cutoff this returns into its query
 * as a bound `timestamptz`.
 */

/** Days an unresolved failure must age before it is listed. */
export const FAIL_LIST_ENTRY_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * The latest failure-episode start that is listed at `now`.
 *
 * Exactly `FAIL_LIST_ENTRY_DAYS × 24 hours` before `now`, as an instant: an
 * episode whose first failure was submitted at or before this moment is
 * listed, one submitted even a millisecond later is not. Fixed 24-hour days
 * rather than Postgres `interval '30 days'`, which is calendar-aware in the
 * session time zone and would make the boundary move by an hour across a
 * daylight-saving change in whatever zone a connection happened to use.
 */
export function failListEntryCutoff(now: Date): Date {
	return new Date(now.getTime() - FAIL_LIST_ENTRY_DAYS * DAY_MS);
}
