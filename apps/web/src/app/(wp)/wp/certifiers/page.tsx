import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { CertifiersTable } from "@/components/wp/certifiers-table";

export default function Page() {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Certifiers</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The field testers authorized to submit tests for your water purveyor.
					A certifier can work for more than one purveyor and keeps a single
					account, so blocking one here stops them signing in to the{" "}
					<strong className="font-semibold text-foreground">platform</strong> —
					not just to your dashboard.
				</p>
			</div>

			<CertifiersTable />
		</div>
	);
}
