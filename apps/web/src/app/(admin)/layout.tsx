import { AdminShell } from "@/components/shell/admin-shell";
import { requireGlobalRole } from "@/lib/auth";

/**
 * Super-Admin only. The shell carries the invite-new-WP action, which
 * provisions water purveyors, so the whole section is gated rather than just
 * the button — anyone else is sent to their own dashboard.
 *
 * Full loads and refreshes only — a client-side navigation reuses this layout,
 * so every page under it carries the same gate.
 */
export default async function AdminLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const account = await requireGlobalRole(["super_admin"]);

	return <AdminShell account={account}>{children}</AdminShell>;
}
