import { WpShell } from "@/components/shell/wp-shell";
import { requireAccount } from "@/lib/auth";

/**
 * `requireAccount`, not a bare session check: the shell names the signed-in
 * user in its sidebar, which takes the `profiles` row, and resolving that row
 * is also what turns a platform-wide block into an actual loss of access.
 *
 * Full loads and refreshes only — a client-side navigation reuses this layout,
 * so every page under it carries the same gate.
 */
export default async function WpLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const account = await requireAccount();

	return <WpShell account={account}>{children}</WpShell>;
}
