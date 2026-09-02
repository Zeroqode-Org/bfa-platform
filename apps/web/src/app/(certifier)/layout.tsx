import { CertifierShell } from "@/components/shell/certifier-shell";

export default function CertifierLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <CertifierShell>{children}</CertifierShell>;
}
