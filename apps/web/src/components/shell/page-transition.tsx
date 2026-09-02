"use client";

import { usePathname } from "next/navigation";

/**
 * One calm enter transition per route: content fades in and rises 4px. Keyed on
 * the pathname so it replays on navigation; disabled under reduced-motion.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	return (
		<div key={pathname} className="motion-safe:animate-page-enter">
			{children}
		</div>
	);
}
