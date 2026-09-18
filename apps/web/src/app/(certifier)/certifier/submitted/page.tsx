import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { SubmissionsTable } from "@/components/certifier/submissions-table";
import { requireGlobalRole } from "@/lib/auth";

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ submission?: string | string[] }>;
}) {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	// Certifiers only — an impersonated WP admin goes to `/wp`, never into the
	// certifier shell, which carries no impersonation banner.
	await requireGlobalRole(["certifier"]);

	// `?submission=<id>` opens that record on arrival, the same deep-link
	// contract `/wp/tests` uses for `?test=`. A repeated param arrives as an
	// array and is ignored rather than guessed at.
	const { submission } = await searchParams;
	const initialSubmissionId =
		typeof submission === "string" ? submission : undefined;

	return (
		<div className="flex flex-col gap-5">
			<PageTitle>Submitted PDFs</PageTitle>
			<SubmissionsTable initialSubmissionId={initialSubmissionId} />
		</div>
	);
}
