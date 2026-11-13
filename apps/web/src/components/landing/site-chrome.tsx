import { buttonVariants } from "@bfa-platform/ui/components/button";
import { cn } from "@bfa-platform/ui/lib/utils";
import { Droplet } from "lucide-react";
import Link from "next/link";

/**
 * Header and footer shared by the public pages — the landing page and Terms &
 * Conditions. Server components: nothing here is interactive.
 */

export function BrandMark({ className }: { className?: string }) {
	return (
		<Link
			href="/"
			className={cn("flex items-center gap-2.5 sm:gap-3", className)}
		>
			<span className="flex size-8 items-center justify-center rounded-full border-2 border-primary sm:size-9">
				<Droplet className="size-4 text-primary sm:size-5" aria-hidden="true" />
			</span>
			<span className="font-semibold text-base tracking-tight sm:text-lg">
				BackflowReporter.io
			</span>
		</Link>
	);
}

export function SiteHeader({ sectionLinks }: { sectionLinks: boolean }) {
	return (
		<header className="sticky top-0 z-30 border-border border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
			<div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-8 sm:py-4">
				<BrandMark />
				<nav
					aria-label="Main"
					className="flex items-center gap-2 text-muted-foreground text-sm sm:gap-6"
				>
					{sectionLinks ? (
						<>
							<a
								href="#platform"
								className="hidden transition-colors hover:text-foreground md:inline"
							>
								Purveyor Platform
							</a>
							<a
								href="#standards"
								className="hidden transition-colors hover:text-foreground md:inline"
							>
								Tester Portal
							</a>
						</>
					) : null}
					<Link
						href="/login"
						className={cn(
							buttonVariants({ variant: "ghost" }),
							"font-medium text-foreground",
						)}
					>
						Log in
					</Link>
					<a
						href={sectionLinks ? "#contact" : "/#contact"}
						className={cn(
							buttonVariants({ variant: "outline" }),
							"hidden font-medium sm:inline-flex",
						)}
					>
						Contact Us
					</a>
				</nav>
			</div>
		</header>
	);
}

export function SiteFooter() {
	return (
		<footer className="border-border border-t bg-card">
			<div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-5 text-muted-foreground text-sm sm:px-8 md:flex-row md:items-center md:justify-between">
				<div className="flex flex-wrap items-center gap-x-5 gap-y-1">
					<span>© {new Date().getFullYear()} BackflowReporter.io</span>
					<Link
						href="/terms"
						className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
					>
						Terms of Service
					</Link>
					<Link
						href="/privacy"
						className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
					>
						Privacy Policy
					</Link>
				</div>
				<span>
					Built for water purveyors, certified testers, and safer communities.
				</span>
			</div>
		</footer>
	);
}
