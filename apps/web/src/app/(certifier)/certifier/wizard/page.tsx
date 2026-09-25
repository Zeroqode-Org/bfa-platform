import { WizardShell } from "@/components/certifier/wizard/wizard-shell";
import { requireGlobalRole } from "@/lib/auth";

/**
 * The certifier test wizard (§ 6.5). Honors the resume contract
 * `DraftsTable`'s "Resume" link already depends on:
 * `/certifier/wizard?draftId=<id>` opens the wizard at that draft's saved
 * step with its saved values intact; no `draftId` starts a fresh test.
 */
export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ draftId?: string }>;
}) {
	// Gated here, not only in the group's layout — see the certifier layout's
	// own note on why a session that stopped being usable mid-session (a WP
	// blocking this certifier) must be checked on every navigation, not just
	// once when the shell first rendered.
	await requireGlobalRole(["certifier"]);

	const { draftId } = await searchParams;

	return <WizardShell draftId={draftId} />;
}
