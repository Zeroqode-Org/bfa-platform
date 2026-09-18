import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { ProfileForm } from "@/components/certifier/profile-form";
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
	const account = await requireGlobalRole(["certifier"]);

	return (
		<div className="flex flex-col gap-5">
			<PageTitle>Profile</PageTitle>
			<ProfileForm email={account.email} />
		</div>
	);
}
