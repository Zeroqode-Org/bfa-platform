import { CertifierShell } from "@/components/shell/certifier-shell";
import { requireGlobalRole } from "@/lib/auth";

/**
 * Certifiers only. Every other role is sent to its own landing route by
 * `requireGlobalRole`. That includes a Super-Admin impersonating a water
 * purveyor, whose effective role is `wp_admin`: this shell has no impersonation
 * banner, so an impersonated identity must never be drawn inside it — it goes to
 * `/wp`, where the banner and its Exit control are always on screen. A UX and
 * transparency boundary only; every procedure still checks the role itself.
 *
 * The role gate resolves the account first, so a valid Supabase session is still
 * not enough to be inside this shell. A certifier a water purveyor has blocked
 * still holds working credentials — `setCertifierStatus` writes
 * `certifiers.status` and nothing in `auth.users` — so the flag has to be read
 * where the caller is resolved, and this is the gate that reads it. Without it
 * a blocked certifier would land on their dashboard and watch every query
 * behind it fail.
 *
 * This covers a full load and a refresh, and nothing else. A client-side
 * navigation re-renders only the changed page on the server and reuses this
 * layout, so every page under it carries the same gate.
 */
export default async function CertifierLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const account = await requireGlobalRole(["certifier"]);

	return <CertifierShell account={account}>{children}</CertifierShell>;
}
