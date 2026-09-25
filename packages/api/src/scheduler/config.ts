/**
 * The scheduler's operating constants, in one place.
 *
 * None of these are per-purveyor settings and none belong in the database. The
 * notice *intervals* are product rules and live in `lib/notice-schedule.ts`;
 * what is here is how the loop behaves — how often it looks, how many rows it
 * takes at a time, how hard it retries — which is an operational property of
 * the process, not of a tenant.
 *
 * Imports nothing, so a test can assert against a tick budget without loading a
 * database connection.
 */

/**
 * How often the loop looks for due work.
 *
 * A minute, because what the product promises is a *day*: a notice due today
 * goes out today, and the difference between 00:00 and 00:01 Honolulu is not a
 * difference a customer can observe. A shorter tick would buy nothing and cost
 * a query per interval forever.
 */
export const TICK_INTERVAL_MS = 60_000;

/**
 * How many due jobs one tick claims.
 *
 * A ceiling rather than a target — ordinary days have none. It exists for the
 * first tick after a restart, or the day a purveyor's flag is switched on with a
 * register full of overdue assemblies, where the alternative is one statement
 * trying to claim and send thousands of notices inside a single tick. Whatever
 * is left over is claimed by the next tick a minute later.
 */
export const CLAIM_BATCH_SIZE = 25;

/**
 * How many delivery attempts a job gets before it is marked `failed`.
 *
 * Counts genuine failures only. Claiming a job does not consume an attempt, and
 * neither does a hold for a missing or suspended customer — a purveyor who
 * leaves an assembly unassigned for a week must not exhaust the retry budget of
 * a notice that was never attempted. What does consume one is a delivery the
 * provider refused, and a run interrupted by a crash, which is what stops a
 * handler that reliably kills its process from looping forever.
 */
export const MAX_JOB_ATTEMPTS = 5;

/** First retry delay. Doubles per attempt, capped at {@link RETRY_MAX_DELAY_MS}. */
export const RETRY_BASE_DELAY_MS = 60_000;

/**
 * The retry ceiling — an hour.
 *
 * Exponential from a minute reaches it by the fifth attempt, which is the point:
 * a provider outage is retried across roughly two hours in total rather than in
 * a burst over five minutes, and a notice that is a day late is still a notice
 * that arrived.
 */
export const RETRY_MAX_DELAY_MS = 3_600_000;

/**
 * How long a job may sit in `running` before it is treated as abandoned.
 *
 * A handler does one template read and one send; ten minutes is far beyond any
 * honest execution and far below the interval a stuck row should survive. Only
 * startup recovery uses it, so the window is never the difference between a slow
 * job and a dead one during normal operation.
 */
export const STALE_RUNNING_AFTER_MS = 600_000;

/**
 * How long a notice waits when the asset has no customer to send it to.
 *
 * A day, and deliberately coarse. The hold is not a retry — nothing failed, and
 * there is nothing to retry until a human attaches a customer to the BIN — so
 * polling it faster would only ask the same question more often. `assignCustomer`
 * pulls a held stage forward the moment an active customer is attached, so this
 * interval is the ceiling on how late a resumed notice can be if that
 * reconciliation is ever missed, not the normal path.
 */
export const RECIPIENT_HOLD_MS = 86_400_000;

/**
 * How long after its first attempt a delivery may still be retried.
 *
 * Resend de-duplicates an `Idempotency-Key` for 24 hours; after that a replay
 * would be treated as a new request and could send a second email. The ceiling
 * is 23 hours so clock skew between this process and the provider cannot put a
 * retry on the wrong side of the provider's window.
 *
 * Ordinary operation never approaches it — five attempts with the backoff below
 * finish within about a quarter of an hour. It exists for the case where the
 * process is down for most of a day between an attempt and its retry, and what
 * happens then is explicit: the job is `failed` with "delivery outcome unknown",
 * not retried blind and not assumed delivered.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 23 * 3_600_000;

/**
 * How long a job of a type this build cannot handle waits before being looked
 * at again.
 *
 * An hour rather than a tick, so a row of a type queued by a newer build —
 * seen by an older deployment still running alongside it — is not re-read
 * sixty times an hour while it waits for the build that knows what to do
 * with it.
 */
export const UNHANDLED_JOB_DEFER_MS = 3_600_000;

/** `attempt`'s backoff delay: base × 2^(attempt−1), capped. */
export function retryDelayMs(attempt: number): number {
	const exponent = Math.max(0, attempt - 1);

	return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}
