"use client";

import { cn } from "@bfa-platform/ui/lib/utils";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { clearImpersonationCookie } from "@/lib/clear-impersonation";
import { createClient } from "@/lib/supabase/client";

/**
 * Ends the session for real — `signOut` clears the auth cookies the tRPC
 * context reads, so the server stops seeing a caller. Styling comes from the
 * call site so each shell keeps the exact look of the link it replaced.
 *
 * The impersonation cookie goes first, while the session still exists: it is
 * `httpOnly` and separate from the Supabase cookies, so `signOut` would leave it
 * behind for the next sign-in to resume.
 */
export function LogoutButton({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	const router = useRouter();
	const [isSigningOut, setIsSigningOut] = useState(false);

	async function handleClick() {
		setIsSigningOut(true);
		await clearImpersonationCookie("sign_out");
		const supabase = createClient();
		await supabase.auth.signOut();
		// refresh() so the server re-reads the now-cleared cookies.
		router.replace("/login");
		router.refresh();
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={isSigningOut}
			className={cn("disabled:opacity-60", className)}
		>
			{children}
		</button>
	);
}
