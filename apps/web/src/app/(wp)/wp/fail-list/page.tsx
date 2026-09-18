import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { FailListTable } from "@/components/wp/fail-list-table";
import { requireAccount } from "@/lib/auth";

/**
 * The fail list, reached from the dashboard's Past due card rather than from a
 * sidebar item of its own — it is a drill-down of that card, not a section.
 * The build plan fixes the handoff, not the URL; `/wp/fail-list`
 * (`failListHref`) is the minimal default.
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
					Assemblies whose latest submitted test failed, oldest failure first.
					An assembly joins the moment a failing test is submitted and leaves
					the moment a passing one is filed — there is no waiting period, and
					the 30- and 60-day colours are age, not entry rules.
				</p>
			</div>

			<FailListTable today={today} />
		</div>
	);
}
