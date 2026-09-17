/**
 * Process startup. The one place the notice scheduler is switched on.
 *
 * Next runs `register()` once per server process, before the first request is
 * handled, which is exactly the hook an application-level scheduler needs and
 * the reason this feature needs no cron of any kind — not Vercel Cron, not OS
 * cron, not a provider queue (`bfa-requirements`, "Portability"). Nothing here
 * is Vercel-specific: the same file runs under `next start` inside a Dockerfile.
 *
 * Gated on `SCHEDULER_ENABLED`, which is off by default. The schedule itself
 * lives in `scheduled_jobs`, so a process that does not tick is not a process
 * with a broken schedule — it is simply not the one doing the work. That keeps
 * a developer's checkout and CI from mailing anybody on a timer, and leaves
 * switching it on a deployment decision.
 *
 * `nodejs` only. The scheduler holds a Postgres pool and a long-lived timer,
 * and the edge runtime has neither; the guard is what keeps a future edge
 * bundle from trying to import the database.
 */

export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { env } = await import("@bfa-platform/env/server");

	if (!env.SCHEDULER_ENABLED) return;

	const { startScheduler } = await import("@bfa-platform/api/scheduler/index");

	startScheduler();
}
