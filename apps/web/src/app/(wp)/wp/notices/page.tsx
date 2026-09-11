import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { GeneralInfoBroadcast } from "@/components/wp/general-info-broadcast";
import { NoticeRepairCompanies } from "@/components/wp/notice-repair-companies";
import { NoticeTemplatesEditor } from "@/components/wp/notice-templates-editor";
import { requireAccount } from "@/lib/auth";

export default async function Page() {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	const account = await requireAccount();

	// What the screen renders, not what it is allowed to do. Every procedure
	// behind these components checks the role again for itself — a hidden button
	// is not a permission — and this is what keeps a SubAdmin or an Employee from
	// being shown controls that would only refuse them.
	const canEdit = account.globalRole === "wp_admin";

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Notices &amp; Email</PageTitle>
				<p className="max-w-[70ch] text-[13px] text-muted-foreground">
					The words your customers read. Edit the subject and message for each
					automated notice, send a one-off message to a group of customers, and
					check who a failure notice will tell them to call.
				</p>
			</div>

			<NoticeTemplatesEditor canEdit={canEdit} />
			<GeneralInfoBroadcast canSend={canEdit} />
			<NoticeRepairCompanies />
		</div>
	);
}
