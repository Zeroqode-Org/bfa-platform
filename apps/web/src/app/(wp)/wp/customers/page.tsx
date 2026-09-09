import { PageTitle } from "@bfa-platform/ui/components/page-title";

import { CustomersTable } from "@/components/wp/customers-table";

export default function Page() {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-col gap-1.5">
				<PageTitle>Customers</PageTitle>
				<p className="text-[13px] text-muted-foreground">
					The occupants and billing contacts your automated email is addressed
					to. Customers don&rsquo;t sign in — these records are yours to keep
					current.
				</p>
			</div>

			<CustomersTable />
		</div>
	);
}
