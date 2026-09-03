import { InviteWpDialog } from "@/components/admin/invite-wp-dialog";

import { DashboardShell } from "./dashboard-shell";

export function AdminShell({ children }: { children: React.ReactNode }) {
	return (
		<DashboardShell
			variant="admin"
			headerKicker="Super Admin"
			headerTitle="All water purveyors"
			headerAction={<InviteWpDialog />}
		>
			{children}
		</DashboardShell>
	);
}
