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
import { bfaAssets, testSubmissions } from "@bfa-platform/db/schema";
import { and, eq } from "drizzle-orm";

import type { AuditActor } from "../lib/audit-actor";
import { nextAnnualTestDate } from "../lib/notice-schedule";
import {
	cancelFailureNoticeForSubmission,
	scheduleFailureNotice,
} from "./failure-notice";
import type { JobExecutor } from "./jobs";
import { logSchedulerEvent } from "./logging";
import {
	cancelNoticeChainForPassingTest,
	reconcileAssetNoticeChain,
} from "./notice-chain";

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

		await advanceAnnualTestDate({
			executor,
			submissionId,
			assetId: bfaAssetId,
			waterPurveyorId,
			actor,
		});
	}
}

/**
 * Moves a passed assembly's `annual_test_date` to its next cycle, and puts
 * next year's reminder on the schedule for it (WP/Admin feedback: "after a test
 * is submitted, the due date should move to next year so the annual reminder
 * email can go out").
 *
 * The rule is `nextAnnualTestDate`'s: same day and month, the first
 * anniversary more than the reminder lead after the test. It reads the
 * submission's own `test_date`, so a test linked late moves the date as of the
 * day it was performed, not the day it was linked.
 *
 * Idempotent, and never backwards. Running it again for the same pass — a WP
 * correcting the record, a re-link — computes a date no later than the one
 * now stored and leaves the date alone. Whenever the date stays, the chain the
 * pass cancelled is reconciled back for the stored date, so the reminder still
 * goes out. A pass with no test date, or an asset with no annual test date,
 * has nothing to anchor a next date to and is left alone.
 *
 * A pass later corrected to a fail does not move the date back: the date is
 * the purveyor's to correct on the asset, where changing it reschedules the
 * chain as any other date change does.
 */
async function advanceAnnualTestDate({
	executor,
	submissionId,
	assetId,
	waterPurveyorId,
	actor,
}: {
	executor: JobExecutor;
	submissionId: string;
	assetId: string;
	waterPurveyorId: string;
	actor: AuditActor | null;
}): Promise<void> {
	const [submission] = await executor
		.select({ testDate: testSubmissions.testDate })
		.from(testSubmissions)
		.where(eq(testSubmissions.id, submissionId))
		.limit(1);
	const [asset] = await executor
		.select({ annualTestDate: bfaAssets.annualTestDate })
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	const testDate = submission?.testDate;
	const current = asset?.annualTestDate;
	if (!testDate || !current) return;

	const next = nextAnnualTestDate(current, testDate);

	// The date stays — an early pass that is not this cycle's, or a pass
	// already counted (a correction, a re-link). The cancel above still
	// withdrew the chain, so it is put back for the date as it stands;
	// otherwise the assembly would never be reminded about again.
	if (!next) {
		await reconcileAssetNoticeChain({
			executor,
			assetId,
			waterPurveyorId,
			annualTestDate: current,
			actor,
			trigger: "passing_test_submitted",
		});

		return;
	}

	await executor
		.update(bfaAssets)
		.set({ annualTestDate: next, updatedAt: new Date() })
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		);

	// The pass above cancelled whatever was live; this queues next year's
	// reminder for the new date, exactly as a WP changing the date would.
	await reconcileAssetNoticeChain({
		executor,
		assetId,
		waterPurveyorId,
		annualTestDate: next,
		actor,
		trigger: "passing_test_submitted",
	});

	logSchedulerEvent("scheduler_annual_test_date_advanced", {
		assetId,
		waterPurveyorId,
		actor,
		extra: {
			from: current,
			to: next,
			test_date: testDate,
			submission_id: submissionId,
		},
	});
}
