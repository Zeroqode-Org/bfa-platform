import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { WaterPurveyorsTable } from "@/components/admin/water-purveyors-table";

export default function Page() {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Water purveyors</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					Every water purveyor on the platform, with its assets, authorized
					certifiers, and submitted tests.
				</p>
			</div>

			<WaterPurveyorsTable />
		</div>
	);
}
