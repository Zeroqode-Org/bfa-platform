import { PageTitle } from "@bfa-platform/ui/components/page-title";
import { CertifiersTable } from "@/components/wp/certifiers-table";
import { requireAccount } from "@/lib/auth";

export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	const account = await requireAccount();

	// What the screen renders, not what it is allowed to do — blocking and
	// moving a certifier between tabs are Admin and SubAdmin only, and both
	// procedures check that again for themselves.
	const canManage =
		account.globalRole === "wp_admin" || account.globalRole === "wp_sub_admin";

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Certifiers</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The field testers authorized to submit tests for your water purveyor.
					A certifier can work for more than one purveyor and keeps a single
					account, so blocking one here stops them signing in to the{" "}
					<strong className="font-semibold text-foreground">platform</strong> —
					not just to your dashboard.
				</p>
			</div>

			<CertifiersTable canManage={canManage} />
		</div>
	);
}
