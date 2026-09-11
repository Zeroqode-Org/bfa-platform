import type { Account } from "@/lib/auth";

import { DashboardShell } from "./dashboard-shell";

export function WpShell({
	account,
	children,
}: {
	account: Account;
	children: React.ReactNode;
}) {
	// Placeholder label until the tRPC caller context resolves the WP.
	return (
		<DashboardShell
			variant="wp"
			account={account}
			headerKicker="Water Purveyor"
			headerTitle="Company name"
		>
			{children}
		</DashboardShell>
	);
}
