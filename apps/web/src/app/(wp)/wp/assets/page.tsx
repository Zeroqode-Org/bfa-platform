import { PageTitle } from "@bfa-platform/ui/components/page-title";
import { AssetsTable } from "@/components/wp/assets-table";
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
				<PageTitle>BFA Assets</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The assemblies you&rsquo;re responsible for. Registering one here
					needs no certifier submission, and the annual test date you give it is
					what the reminder schedule runs from.
				</p>
			</div>

			<AssetsTable />
		</div>
	);
}
