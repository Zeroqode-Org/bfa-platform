import { PlaceholderPage } from "@/components/placeholder-page";
import { requireGlobalRole } from "@/lib/auth";

export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	// Certifiers only — an impersonated WP admin goes to `/wp`, never into the
	// certifier shell, which carries no impersonation banner.
	await requireGlobalRole(["certifier"]);

	return <PlaceholderPage title="Profile" route="/certifier/profile" />;
}
