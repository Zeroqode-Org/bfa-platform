import { PlaceholderPage } from "@/components/placeholder-page";
import { requireGlobalRole } from "@/lib/auth";

/**
 * The wizard itself is § 6.5, not built here. What this task ships is the
 * contract 6.5 must honor: a draft's "Resume" link is
 * `/certifier/wizard?draftId=<id>`, and `certifier.getDraft` already scopes
 * and reads that draft's `wizardData` and `currentStep` — the read half of
 * "resume opens the wizard at the saved step with saved values intact" is in
 * place; the wizard UI that consumes it is not.
 */
export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	// Certifiers only — an impersonated WP admin goes to `/wp`, never into the
	// certifier shell, which carries no impersonation banner.
	await requireGlobalRole(["certifier"]);

	return <PlaceholderPage title="New Test" route="/certifier/wizard" />;
}
