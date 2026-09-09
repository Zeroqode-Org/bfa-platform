"use client";

import { cn } from "@bfa-platform/ui/lib/utils";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Ends the session for real — `signOut` clears the auth cookies the tRPC
 * context reads, so the server stops seeing a caller. Styling comes from the
 * call site so each shell keeps the exact look of the link it replaced.
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
