import { db } from "@bfa-platform/db";
import { waterPurveyors } from "@bfa-platform/db/schema";
import { eq } from "drizzle-orm";

/**
 * Whether a water purveyor is blocked, read at send time.
 *
 * A Super-Admin blocking a purveyor closes its dashboard; it also has to stop
 * the platform writing to that purveyor's customers on its behalf (WP/Admin
 * feedback). Every automated email checks this before it is sent — the
 * reminder chain and the failure notice through `resolveRecipient`, the AG
 * renewal notice in its own handler.
 *
 * A block *holds* the email rather than cancelling it, exactly like a suspended
 * customer: blocking is reversible, and an unblocked purveyor's customers
 * should get the stage that was waiting, not lose it. A purveyor row that is
 * missing reads as blocked — there is no one to send on behalf of.
 */
export async function isPurveyorBlocked(
	waterPurveyorId: string,
): Promise<boolean> {
	const [purveyor] = await db
		.select({ status: waterPurveyors.status })
		.from(waterPurveyors)
		.where(eq(waterPurveyors.id, waterPurveyorId))
		.limit(1);

	return purveyor?.status !== "active";
}
