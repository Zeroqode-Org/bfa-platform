import { CertifierShell } from "@/components/shell/certifier-shell";
import { requireCaller } from "@/lib/auth";

/**
 * `requireCaller`, not `requireUser`: a valid Supabase session is not enough to
 * be inside this shell. A certifier a water purveyor has blocked still holds
 * working credentials — `setCertifierStatus` writes `certifiers.status` and
 * nothing in `auth.users` — so the flag has to be read where the caller is
 * resolved, and this is the gate that reads it. Without it a blocked certifier
 * would land on their dashboard and watch every query behind it fail.
 */
export default async function CertifierLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	await requireCaller();

	return <CertifierShell>{children}</CertifierShell>;
}
