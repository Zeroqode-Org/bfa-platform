import { PageTitle } from "@bfa-platform/ui/components/page-title";
import { RepairCompaniesTable } from "@/components/wp/repair-companies-table";
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
				<PageTitle>Repair Companies</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The repair firms you approve for your customers. Only{" "}
					<strong className="font-semibold text-foreground">active</strong>{" "}
					companies are listed in a failure notice — the list is resolved when
					the notice is sent, so deactivating one keeps its record without
					recommending it again.
				</p>
			</div>

			<RepairCompaniesTable />
		</div>
	);
}
