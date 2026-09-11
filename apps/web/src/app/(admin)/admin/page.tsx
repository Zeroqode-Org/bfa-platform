import { PageTitle } from "@bfa-platform/ui/components/page-title";
import { WaterPurveyorsTable } from "@/components/admin/water-purveyors-table";
import { requireGlobalRole } from "@/lib/auth";

export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireGlobalRole(["super_admin"]);

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Water purveyors</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					Every water purveyor on the platform, with its assets, authorized
					certifiers, and submitted tests.
				</p>
			</div>

			<WaterPurveyorsTable />
		</div>
	);
}
