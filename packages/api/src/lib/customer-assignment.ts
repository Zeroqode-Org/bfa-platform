import { bfaAssets, customerAssignments } from "@bfa-platform/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { JobExecutor } from "../scheduler/jobs";
import { resumeHeldNoticeChain } from "../scheduler/notice-chain";
import type { AuditActor } from "./audit-actor";

/**
 * Makes a customer the current occupant of an asset, preserving whoever was
 * there before.
 *
 * Three writes, which the caller runs inside its transaction: close the open
 * occupancy row with today's `end_date`, open a new one starting today, and
 * move the asset's live pointer. Doing only the third — the update a "current
 * customer" field invites — would answer "who gets the email" while quietly
 * erasing "who had this valve last year", which is the question a disputed
 * test needs.
 *
 * Both dates come from `current_date` in Postgres rather than from the Node
 * process, so the closing and the opening row cannot disagree about what day
 * it is.
 *
 * Shared by `assets.assignCustomer` and the customer form's BIN, so attaching
 * from either side writes the same history. Everything a caller must decide
 * first — that both rows are the caller's own, that this is a real change, and
 * that a suspended customer or a move away from another occupant was confirmed
 * — stays with the caller, because each screen asks those questions its own
 * way.
 */
export async function attachCustomerToAsset({
	executor,
	assetId,
	customerId,
	customerStatus,
	waterPurveyorId,
	actor,
}: {
	executor: JobExecutor;
	assetId: string;
	customerId: string;
	customerStatus: "active" | "suspended";
	waterPurveyorId: string;
	actor: AuditActor;
}) {
	await executor
		.update(customerAssignments)
		.set({ endDate: sql`current_date` })
		.where(
			and(
				eq(customerAssignments.bfaAssetId, assetId),
				isNull(customerAssignments.endDate),
			),
		);

	await executor.insert(customerAssignments).values({
		bfaAssetId: assetId,
		customerId,
		startDate: sql`current_date`,
	});

	await executor
		.update(bfaAssets)
		.set({ currentCustomerId: customerId })
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		);

	// Attaching an *active* customer is what ends a hold. A suspended one
	// continues it, which is the confirmed rule (PRD § 9): the asset's notices
	// stop entirely until somebody who can be written to is attached to the BIN.
	//
	// What resumes is the single stage that was waiting, and nothing already
	// sent is replayed — see `resumeHeldNoticeChain` for why that reading was
	// chosen over restarting the chain or skipping to whichever stage the
	// calendar now says is due.
	if (customerStatus === "active") {
		await resumeHeldNoticeChain({
			executor,
			assetId,
			waterPurveyorId,
			actor,
		});
	}
}
