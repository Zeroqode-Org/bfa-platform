import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { SubmittedTestsTable } from "@/components/wp/submitted-tests-table";
import { requireAccount } from "@/lib/auth";

export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireAccount();

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Submitted Tests</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					Every test filed against your purveyor, by every certifier who works
					for you. Open one to read it as a document — and to correct it, which
					the certifier who filed it can no longer do.
				</p>
			</div>

			<SubmittedTestsTable />
		</div>
	);
}
