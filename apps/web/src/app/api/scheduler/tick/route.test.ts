import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tick route as a lock and a trigger: it answers only a caller holding the
 * secret, and then runs one recovery pass and one scheduler pass. What a pass
 * does is the scheduler's, covered against Postgres in its own suites; here
 * both are spies, so this stays offline.
 */

const SECRET = "s".repeat(40);

const env: { SCHEDULER_TICK_SECRET?: string } = {};
const recoverInterruptedJobs = vi.fn();
const runSchedulerTick = vi.fn();

vi.mock("@bfa-platform/env/server", () => ({ env }));
vi.mock("@bfa-platform/api/scheduler/index", () => ({
	recoverInterruptedJobs: () => recoverInterruptedJobs(),
	runSchedulerTick: () => runSchedulerTick(),
}));

const { POST } = await import("./route");

function tick(authorization?: string) {
	return POST(
		new Request("https://bfa.example.com/api/scheduler/tick", {
			method: "POST",
			headers: authorization ? { authorization } : {},
		}),
	);
}

const IDLE_TICK = {
	statusesChanged: 0,
	claimed: 0,
	sent: 0,
	held: 0,
	cancelled: 0,
	superseded: 0,
	retrying: 0,
	failed: 0,
	unhandled: 0,
};

beforeEach(() => {
	vi.clearAllMocks();
	env.SCHEDULER_TICK_SECRET = SECRET;
	recoverInterruptedJobs.mockResolvedValue({ recovered: 0, failed: 0 });
	runSchedulerTick.mockResolvedValue(IDLE_TICK);
});

describe("POST /api/scheduler/tick", () => {
	it("does not exist when no secret is configured", async () => {
		env.SCHEDULER_TICK_SECRET = undefined;

		const response = await tick(`Bearer ${SECRET}`);

		expect(response.status).toBe(404);
		expect(runSchedulerTick).not.toHaveBeenCalled();
	});

	it("refuses a missing or wrong token without running anything", async () => {
		for (const header of [
			undefined,
			SECRET,
			`Bearer ${"x".repeat(40)}`,
			`Bearer ${SECRET}x`,
		]) {
			const response = await tick(header);

			expect(response.status).toBe(401);
		}

		expect(recoverInterruptedJobs).not.toHaveBeenCalled();
		expect(runSchedulerTick).not.toHaveBeenCalled();
	});

	it("recovers interrupted jobs, runs one pass, and reports both", async () => {
		recoverInterruptedJobs.mockResolvedValue({ recovered: 1, failed: 0 });
		runSchedulerTick.mockResolvedValue({ ...IDLE_TICK, claimed: 2, sent: 2 });
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		const response = await tick(`Bearer ${SECRET}`);

		expect(response.status).toBe(200);
		expect(recoverInterruptedJobs).toHaveBeenCalledTimes(1);
		expect(runSchedulerTick).toHaveBeenCalledTimes(1);
		expect(await response.json()).toMatchObject({
			recovery: { recovered: 1 },
			tick: { claimed: 2, sent: 2 },
		});
	});
});
