import { db } from "@bfa-platform/db";
import { certifiers, profiles, testSubmissions } from "@bfa-platform/db/schema";
import { and, eq } from "drizzle-orm";
import { isPurveyorBlocked } from "../../scheduler/purveyor-status";
import type { AuditActor } from "../audit-actor";
import { sendEmail } from "../email";
import {
	escapeHtml,
	renderCallToAction,
	renderEmailLayout,
	renderEmailParagraph,
} from "../email-layout";
import { resolveProfileEmail } from "../profile-email";
import { publishResultPdf } from "./document-url";
import { renderResultPdf } from "./render";

/** How long the signed link in the distribution email stays valid. */
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Renders the results document, stores it, and mails it to the three
 * recipients build-plan § 6.5 step 23 names: the active water purveyor, the
 * customer captured in the wizard, and the certifier. A missing or failing
 * recipient is skipped, never a reason to fail the submit that called
 * this — each send is wrapped in its own try/catch.
 *
 * The PDF is emailed as a link to a signed Storage URL, not as an attachment
 * — `email.ts`'s `EmailMessage` carries no attachment field, and adding one
 * for this single call site would widen the shared email contract for every
 * other caller. The link expires in a week, long enough for all three
 * recipients to open it once.
 */
export async function sendResultDocumentEmails({
	submissionId,
	actor,
}: {
	submissionId: string;
	actor: AuditActor;
}): Promise<void> {
	const rendered = await renderResultPdf(submissionId);
	const { customerEmail, waterPurveyorId } = rendered;

	const downloadUrl = await publishResultPdf(submissionId, {
		rendered,
		ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
	});

	const [submission] = await db
		.select({ certifierId: testSubmissions.certifierId })
		.from(testSubmissions)
		.where(eq(testSubmissions.id, submissionId))
		.limit(1);

	if (!submission) return;

	const [certifierRow] = await db
		.select({ profileId: certifiers.profileId })
		.from(certifiers)
		.where(eq(certifiers.id, submission.certifierId))
		.limit(1);

	const [wpAdmin] = await db
		.select({ profileId: profiles.id })
		.from(profiles)
		.where(
			and(
				eq(profiles.waterPurveyorId, waterPurveyorId),
				eq(profiles.globalRole, "wp_admin"),
			),
		)
		.limit(1);

	// A blocked purveyor's customers get nothing on its behalf — see
	// `isPurveyorBlocked`. The certifier's and the purveyor's own copies still
	// go: they are the platform's record of the test, not mail to a customer.
	// Keyed on this submission's purveyor, never on the address, so the same
	// person as a customer of another purveyor is unaffected.
	const customerBlocked = await isPurveyorBlocked(waterPurveyorId);

	const recipients: { to: string | null; label: string }[] = [
		{ to: customerBlocked ? null : customerEmail || null, label: "customer" },
		{
			to: certifierRow
				? await resolveProfileEmail(certifierRow.profileId)
				: null,
			label: "certifier",
		},
		{
			to: wpAdmin ? await resolveProfileEmail(wpAdmin.profileId) : null,
			label: "water purveyor",
		},
	];

	const html = renderEmailLayout({
		title: "Backflow test result",
		heading: "A test result is ready",
		bodyHtml: [
			renderEmailParagraph(
				escapeHtml(
					"A backflow assembly test has been submitted. The full result document is available at the link below.",
				),
			),
			renderCallToAction({
				href: downloadUrl,
				label: "View the result document",
			}),
		].join("\n"),
	});

	for (const recipient of recipients) {
		if (!recipient.to) continue;

		try {
			await sendEmail(
				{
					to: recipient.to,
					subject: "Backflow test result",
					html,
					tags: [{ name: "event", value: "test_submitted" }],
				},
				{ event: "test_submitted", actor, wpId: waterPurveyorId },
			);
		} catch {
			// Already logged by `sendEmail` itself; one recipient's failure must
			// never block the other two or the submit that triggered this.
		}
	}
}
