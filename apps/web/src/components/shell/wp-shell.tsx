import type { Account } from "@/lib/auth";

import { DashboardShell } from "./dashboard-shell";

export function WpShell({
	account,
	children,
}: {
	account: Account;
	children: React.ReactNode;
}) {
	return (
		<DashboardShell
			variant="wp"
			account={account}
			headerKicker="Water Purveyor"
			headerTitle={account.waterPurveyorName ?? "Water Purveyor"}
		>
			{children}
		</DashboardShell>
	);
}
