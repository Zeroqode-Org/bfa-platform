import { AssetDetailView } from "@/components/wp/asset-detail";
import { requireAccount } from "@/lib/auth";

export default async function Page({
	params,
}: {
	params: Promise<{ assetId: string }>;
}) {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireAccount();

	const { assetId } = await params;

	return <AssetDetailView assetId={assetId} />;
}
