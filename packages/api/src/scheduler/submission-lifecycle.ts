/**
 * What a submitted test's result means for the notice machinery, stated once.
 *
 * Every path that can make a submitted row's `(bfa_asset_id, test_result)`
 * pair what it now is calls this — `updateSubmittedTest`, `linkSubmissionAsset`,
 * and the certifier wizard's submit when it lands (§ 6.5) — instead of each
 * caller re-deriving which chains to cancel and which notices to queue. A
 * caller that forgot one half would ship a pass that stops the escalation but
 * leaves a failure email queued, or a fail that mails nobody.
 *
 * The rules, from the build plan:
 *
 * - A **linked pass** ends the assembly's escalation chain, and withdraws the
 *   unsent failure notice of *this* submission if a correction just turned it
 *   from a fail into a pass. (A failure notice already delivered is a fact and
 *   stays on the record.) A re-test is a *new* submitted record, not an edit:
 *   when that new pass arrives, the earlier fail's still-unsent notice is
 *   cancelled by the failure-notice handler, which re-checks for a later pass
 *   before every send.
 * - A **linked fail** queues that submission's one failure notice, due now.
 *   Idempotent at the database: a still-failing row saved again writes
 *   nothing. It cancels nothing — the assembly is still untested as far as the
 *   escalation is concerned.
 *
 * Nothing here writes fail-list state, and nothing needs to: the list is read
 * from submitted history, and an asset appears on it only after its failure
 * has gone 30 days without a later submitted pass (`listFailingAssets`). The
 * email is immediate; the list is not.
 * - A submitted row that is **neither** (result cleared, or corrected while
 *   unlinked) withdraws its own unsent failure notice and touches no chain.
 * - An **unlinked** submission of any result touches nothing else: it
 *   represents no assembly yet. When a WP later links it, this function runs
 *   again with the link in place and the fail (or pass) takes effect then —
 *   which is exactly the late-link flow.
 *
 * Drafts never reach here. The submitted-tests router pins
 * `status = 'submitted'` on every query, and the wizard calls this only at
 * submit — a draft sends nothing and appears nowhere, by construction rather
 * than by a check this function could forget.
 *
 * Runs inside the caller's own transaction (`executor`), so a correction that
 * rolls back schedules and cancels nothing.
 */

import { db } from "@bfa-platform/db";

import type { AuditActor } from "../lib/audit-actor";
import {
	cancelFailureNoticeForSubmission,
	scheduleFailureNotice,
} from "./failure-notice";
import type { JobExecutor } from "./jobs";
import { cancelNoticeChainForPassingTest } from "./notice-chain";

/** Which write brought the submission to this state, for the log lines. */
export type SubmissionLifecycleTrigger =
	| "test_submission_corrected"
	| "test_submission_asset_linked"
	| "test_submitted";

export async function applySubmittedTestResult({
	executor = db,
	submissionId,
	bfaAssetId,
	testResult,
	waterPurveyorId,
	actor = null,
	trigger,
	now = new Date(),
}: {
	executor?: JobExecutor;
	submissionId: string;
	/** The submission's asset link as it stands *after* the caller's write. */
	bfaAssetId: string | null;
	/** The submission's result as it stands *after* the caller's write. */
	testResult: "pass" | "fail" | null;
	waterPurveyorId: string;
	actor?: AuditActor | null;
	trigger: SubmissionLifecycleTrigger;
	now?: Date;
}): Promise<void> {
	if (bfaAssetId && testResult === "fail") {
		await scheduleFailureNotice({
			executor,
			submissionId,
			assetId: bfaAssetId,
			waterPurveyorId,
			actor,
			trigger,
			now,
		});

		return;
	}

	// Not a linked fail any more (or never was): whatever unsent failure notice
	// this submission has is now about a fail that is no longer on the record.
	await cancelFailureNoticeForSubmission({
		executor,
		submissionId,
		assetId: bfaAssetId,
		waterPurveyorId,
		actor,
		trigger,
	});

	if (bfaAssetId && testResult === "pass") {
		await cancelNoticeChainForPassingTest({
			executor,
			assetId: bfaAssetId,
			waterPurveyorId,
			actor,
			submissionId,
		});
	}
}
