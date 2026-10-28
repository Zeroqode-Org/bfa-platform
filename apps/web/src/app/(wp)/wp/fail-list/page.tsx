import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { FailListTable } from "@/components/wp/fail-list-table";
import { requireAccount } from "@/lib/auth";

/**
 * The fail list, reached from its own sidebar item. The build plan routed it
 * through the dashboard's Past due card; the client asked for that card to
 * open the past-due assets instead, so the list got a section of its own.
 */
export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireAccount();

	// Which calendar day today is, decided once on the server and handed down —
	// the same UTC instant-to-day convention the dashboard uses, so an age
	// computed here matches the day the procedure's `failingSince` was named in.
	const today = new Date().toISOString().slice(0, 10);

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Fail List</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					Assemblies with a failed test that has gone 30 days without a passing
					re-test, oldest failure first. The failure email goes to the customer
					as soon as the test is submitted; an assembly joins this list only
					once 30 days pass with no passing test filed, and leaves as soon as
					one is. The colours mark failures past 60 days.
				</p>
			</div>

			<FailListTable today={today} />
		</div>
	);
}
