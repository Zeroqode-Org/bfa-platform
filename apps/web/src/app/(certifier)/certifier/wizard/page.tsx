import { PlaceholderPage } from "@/components/placeholder-page";
import { requireAccount } from "@/lib/auth";

/**
 * The wizard itself is § 6.5, not built here. What this task ships is the
 * contract 6.5 must honor: a draft's "Resume" link is
 * `/certifier/wizard?draftId=<id>`, and `certifier.getDraft` already scopes
 * and reads that draft's `wizardData` and `currentStep` — the read half of
 * "resume opens the wizard at the saved step with saved values intact" is in
 * place; the wizard UI that consumes it is not.
 */
export default async function Page() {
	await requireAccount();

	return <PlaceholderPage title="New Test" route="/certifier/wizard" />;
}
