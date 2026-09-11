import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { WpDashboard } from "@/components/wp/wp-dashboard";
import { requireAccount } from "@/lib/auth";

export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireAccount();

	// Which calendar day today is, decided once on the server and handed down.
	//
	// `WpDashboard` is a client component, which Next renders on the server
	// first — so a default date range or an overdue count derived from
	// `new Date()` inside it would be computed twice, a moment apart, either
	// side of the hydration boundary.
	//
	// `toISOString` names the day in UTC. That is the same instant-to-day
	// conversion `dashboard-calendar` makes for "this month" and the trailing
	// twelve, done the same way for the same reason, so the screen cannot label
	// a figure with a different day than the procedure counted. Everything
	// downstream of this line is zone-free calendar arithmetic against `date`
	// columns.
	const today = new Date().toISOString().slice(0, 10);

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Home</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					Where your system stands today — what has come in, what is overdue,
					and how the year is trending. Every figure counts only your own rows.
				</p>
			</div>

			<WpDashboard today={today} />
		</div>
	);
}
