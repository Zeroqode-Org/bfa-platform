import { CertifierShell } from "@/components/shell/certifier-shell";
import { requireUser } from "@/lib/auth";

export default async function CertifierLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireUser();

	return <CertifierShell>{children}</CertifierShell>;
}
