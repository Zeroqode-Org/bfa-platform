import { bfaAssets, customerAssignments } from "@bfa-platform/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { JobExecutor } from "../scheduler/jobs";
import { resumeHeldNoticeChain } from "../scheduler/notice-chain";
import type { AuditActor } from "./audit-actor";

/**
 * Ends the asset's open occupancy row, if it has one, with today's
 * `end_date`. The first step of both attaching and detaching, so the history
 * is closed the same way whichever one ends it.
 */
async function closeOpenAssignment(executor: JobExecutor, assetId: string) {
	await executor
		.update(customerAssignments)
		.set({ endDate: sql`current_date` })
		.where(
			and(
				eq(customerAssignments.bfaAssetId, assetId),
				isNull(customerAssignments.endDate),
			),
		);
}

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
	await closeOpenAssignment(executor, assetId);

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

/**
 * Leaves an asset with no occupant — the customer sold the property, left
 * the site, or handed the assembly on — preserving the occupancy that ended.
 *
 * Two writes, run inside the caller's transaction: close the open occupancy
 * row with today's `end_date`, and clear the asset's live pointer. No new row
 * is opened, which is what makes the asset read as unassigned everywhere.
 *
 * Nothing is done to the asset's scheduled jobs, on purpose. Every notice
 * resolves its recipient from `current_customer_id` when it sends (see
 * `resolveRecipient`), so a stage that has not been attempted yet now finds
 * no customer and holds instead of mailing the former occupant. The hold is
 * the same one an asset that never had a customer sits in, and attaching the
 * next occupant resumes it through `attachCustomerToAsset`.
 */
export async function detachCustomerFromAsset({
	executor,
	assetId,
	waterPurveyorId,
}: {
	executor: JobExecutor;
	assetId: string;
	waterPurveyorId: string;
}) {
	await closeOpenAssignment(executor, assetId);

	await executor
		.update(bfaAssets)
		.set({ currentCustomerId: null })
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		);
}
