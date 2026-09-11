import { InviteWpDialog } from "@/components/admin/invite-wp-dialog";
import type { Account } from "@/lib/auth";

import { DashboardShell } from "./dashboard-shell";

export function AdminShell({
	account,
	children,
}: {
	account: Account;
	children: React.ReactNode;
}) {
	return (
		<DashboardShell
			variant="admin"
			account={account}
			headerKicker="Super Admin"
			headerTitle="All water purveyors"
			headerAction={<InviteWpDialog />}
		>
			{children}
		</DashboardShell>
	);
}
