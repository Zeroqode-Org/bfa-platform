import { PageTitle } from "@bfa-platform/ui/components/page-title";
import { isAssetStatus } from "@/components/wp/asset-types";
import { AssetsTable } from "@/components/wp/assets-table";
import { requireAccount } from "@/lib/auth";

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ status?: string | string[] }>;
}) {
	// Gated here, not only in the group's layout. A layout renders once and is
	// reused across client-side navigations — only the changed page is
	// re-rendered on the server — so a session that stopped being usable after
	// the layout ran would sail straight through. `certifiers.status` is
	// exactly that case: a purveyor can block a certifier who is already
	// signed in and part-way through a session.
	await requireAccount();

	// `?status=<filter>` opens the list already narrowed — how the dashboard's
	// Past Due block reaches every past-due asset rather than the handful it
	// shows.
	//
	// Read here rather than with `useSearchParams` inside the table, which would
	// need a Suspense boundary around a screen that is already dynamic. Only one
	// of the filter's own statuses is taken: a repeated `?status=` arrives as an
	// array, and that or an unknown value opens the unfiltered list rather than
	// being guessed at.
	const { status } = await searchParams;
	const initialStatus = isAssetStatus(status) ? status : undefined;

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>BFA Assets</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The assemblies you&rsquo;re responsible for. Registering one here
					needs no certifier submission, and the annual test date you give it is
					what the reminder schedule runs from.
				</p>
			</div>

			{/* Keyed by the preset because moving between `?status=past_due` and
			    the bare route keeps this page mounted: without a new key the
			    table would hold on to the old filter under the new URL. */}
			<AssetsTable key={initialStatus ?? "all"} initialStatus={initialStatus} />
		</div>
	);
}
