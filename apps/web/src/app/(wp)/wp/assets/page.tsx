import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { AssetsTable } from "@/components/wp/assets-table";

export default function Page() {
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

			<AssetsTable />
		</div>
	);
}
