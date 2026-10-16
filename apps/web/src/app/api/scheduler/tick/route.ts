import { timingSafeEqual } from "node:crypto";

import {
	recoverInterruptedJobs,
	runSchedulerTick,
} from "@bfa-platform/api/scheduler/index";
import { env } from "@bfa-platform/env/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One pass claims a bounded batch and sends serially; a minute is ample.
export const maxDuration = 60;

/**
 * One scheduler pass, on request — for an external timer (cron-job.org, a
 * scheduled GitHub Action, an uptime pinger) calling it every few minutes.
 *
 * Why it exists: the scheduler is an in-process loop started from
 * `instrumentation.ts`, which needs a process that stays alive. On Vercel it
 * does not — an instance lives only while requests keep it warm — so with no
 * traffic nothing ticked: statuses went stale and notices were not sent. An
 * outside caller fixes that without tying the platform to a vendor's cron (the
 * portability rule in `bfa-requirements`): the endpoint is plain HTTP, and on
 * a host that keeps a process alive the in-process loop still works as before.
 *
 * Safe to call alongside that loop, or twice at once. The claim is atomic and
 * every email goes out under its job's own idempotency key, so overlapping
 * passes produce one message per job — the same guarantee two instances rely
 * on.
 *
 * Each call also reclaims `running` rows left behind by a pass that died
 * mid-job. The loop does that once at startup; a serverless function that is
 * cut off has no startup to do it in, so it happens here, every time. Only
 * rows stale past `STALE_RUNNING_AFTER_MS` are touched, so a pass still
 * running elsewhere is never taken from.
 *
 * Locked by `SCHEDULER_TICK_SECRET`, sent as `Authorization: Bearer <secret>`.
 * Unset, the route answers 404 — a deployment that never configured it has no
 * such endpoint. POST only: a tick sends email, and a GET is what crawlers and
 * link previews make.
 */
export async function POST(req: Request) {
	const secret = env.SCHEDULER_TICK_SECRET;

	if (!secret) {
		return new Response(null, { status: 404 });
	}

	if (!isAuthorized(req.headers.get("authorization"), secret)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const recovery = await recoverInterruptedJobs();
	const tick = await runSchedulerTick();

	// The same line the in-process loop writes, and only when something
	// happened — an idle pass every few minutes is not news.
	if (
		recovery.recovered > 0 ||
		recovery.failed > 0 ||
		tick.claimed > 0 ||
		tick.statusesChanged > 0 ||
		tick.unhandled > 0
	) {
		console.log(
			JSON.stringify({
				event: "scheduler_tick",
				source: "http",
				...recovery,
				...tick,
				timestamp: new Date().toISOString(),
			}),
		);
	}

	return Response.json({ recovery, tick });
}

/** `Bearer <secret>`, compared in constant time. */
function isAuthorized(header: string | null, secret: string) {
	const presented = Buffer.from(header ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);

	return (
		presented.length === expected.length && timingSafeEqual(presented, expected)
	);
}
