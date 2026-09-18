import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { SubmissionsTable } from "@/components/certifier/submissions-table";
import { requireAccount } from "@/lib/auth";

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ submission?: string | string[] }>;
}) {
	await requireAccount();

	// `?submission=<id>` opens that record on arrival, the same deep-link
	// contract `/wp/tests` uses for `?test=`. A repeated param arrives as an
	// array and is ignored rather than guessed at.
	const { submission } = await searchParams;
	const initialSubmissionId =
		typeof submission === "string" ? submission : undefined;

	return (
		<div className="flex flex-col gap-5">
			<PageTitle>Submitted PDFs</PageTitle>
			<SubmissionsTable initialSubmissionId={initialSubmissionId} />
		</div>
	);
}
