import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { ProfileForm } from "@/components/certifier/profile-form";
import { requireAccount } from "@/lib/auth";

export default async function Page() {
	const account = await requireAccount();

	return (
		<div className="flex flex-col gap-5">
			<PageTitle>Profile</PageTitle>
			<ProfileForm email={account.email} />
		</div>
	);
}
