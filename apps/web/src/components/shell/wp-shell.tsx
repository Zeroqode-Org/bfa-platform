import { DashboardShell } from "./dashboard-shell";

export function WpShell({ children }: { children: React.ReactNode }) {
	// Placeholder label until the tRPC caller context resolves the WP.
	return (
		<DashboardShell
			variant="wp"
			headerKicker="Water Purveyor"
			headerTitle="Company name"
		>
			{children}
		</DashboardShell>
	);
}
