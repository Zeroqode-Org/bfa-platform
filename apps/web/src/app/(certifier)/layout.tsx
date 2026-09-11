import { CertifierShell } from "@/components/shell/certifier-shell";
import { requireAccount } from "@/lib/auth";

/**
 * `requireAccount`, not a bare session check: a valid Supabase session is not
 * enough to be inside this shell. A certifier a water purveyor has blocked
 * still holds working credentials — `setCertifierStatus` writes
 * `certifiers.status` and nothing in `auth.users` — so the flag has to be read
 * where the caller is resolved, and this is the gate that reads it. Without it
 * a blocked certifier would land on their dashboard and watch every query
 * behind it fail.
 *
 * This covers a full load and a refresh, and nothing else. A client-side
 * navigation re-renders only the changed page on the server and reuses this
 * layout, so every page under it carries the same gate.
 */
export default async function CertifierLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const account = await requireAccount();

	return <CertifierShell account={account}>{children}</CertifierShell>;
}
