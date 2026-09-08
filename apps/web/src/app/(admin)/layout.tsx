import { AdminShell } from "@/components/shell/admin-shell";
import { requireUser } from "@/lib/auth";

export default async function AdminLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireUser();

	return <AdminShell>{children}</AdminShell>;
}
