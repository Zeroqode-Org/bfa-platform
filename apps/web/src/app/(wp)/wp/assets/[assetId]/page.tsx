import { AssetDetailView } from "@/components/wp/asset-detail";

export default async function Page({
	params,
}: {
	params: Promise<{ assetId: string }>;
}) {
	const { assetId } = await params;

	return <AssetDetailView assetId={assetId} />;
}
