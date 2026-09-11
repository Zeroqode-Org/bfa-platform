import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { SubmittedTestsTable } from "@/components/wp/submitted-tests-table";
import { requireAccount } from "@/lib/auth";

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ test?: string | string[] }>;
}) {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireAccount();

	// `?test=<id>` opens that record's document on arrival — how the home
	// screen's incoming-reports list drills in, without a second detail view
	// existing anywhere.
	//
	// Read here rather than with `useSearchParams` inside the table, which would
	// need a Suspense boundary around a screen that is already dynamic. Taken as
	// a value and no further: a repeated `?test=` arrives as an array and is
	// ignored rather than guessed at, and the id itself is never trusted —
	// `getSubmittedTest` scopes by tenant and status, so a foreign id, a draft
	// id and an invented one all get the same not-found.
	const { test } = await searchParams;
	const initialSubmissionId = typeof test === "string" ? test : undefined;

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Submitted Tests</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					Every test filed against your purveyor, by every certifier who works
					for you. Open one to read it as a document — and to correct it, which
					the certifier who filed it can no longer do.
				</p>
			</div>

			<SubmittedTestsTable initialSubmissionId={initialSubmissionId} />
		</div>
	);
}
