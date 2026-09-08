import { WpShell } from "@/components/shell/wp-shell";
import { requireUser } from "@/lib/auth";

export default async function WpLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireUser();

	return <WpShell>{children}</WpShell>;
}
