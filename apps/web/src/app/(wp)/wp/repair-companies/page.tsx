import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { RepairCompaniesTable } from "@/components/wp/repair-companies-table";

export default function Page() {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Repair Companies</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The repair firms you approve for your customers. Only{" "}
					<strong className="font-semibold text-foreground">active</strong>{" "}
					companies are listed in a failure notice — the list is resolved when
					the notice is sent, so deactivating one keeps its record without
					recommending it again.
				</p>
			</div>

			<RepairCompaniesTable />
		</div>
	);
}
