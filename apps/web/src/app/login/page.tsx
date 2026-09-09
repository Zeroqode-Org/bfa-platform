import type { Route } from "next";

import { LoginForm } from "@/components/auth/login-form";

/**
 * Sign-in screen. Deliberately minimal: no sign-up and no password reset —
 * accounts exist only because someone redeemed an invitation.
 *
 * `?redirect=` is honoured for the one flow that needs it: an existing
 * certifier redeeming a second purveyor's invitation without a live session.
 * It is validated here rather than in the client component, so a crafted link
 * cannot turn the sign-in screen into an open redirect.
 */
export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ redirect?: string | string[] }>;
}) {
	const { redirect } = await searchParams;
	const requested = Array.isArray(redirect) ? redirect[0] : redirect;

	return (
		<main className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
			<div className="w-full max-w-[420px]">
				<div className="mb-5 flex items-center justify-center gap-2.5">
					<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
						<svg
							viewBox="0 0 24 24"
							className="size-4"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<title>Backflow Assembly</title>
							<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
						</svg>
					</span>
					<span className="font-bold text-[13px] text-foreground tracking-tight">
						Backflow Assembly
					</span>
				</div>

				<div className="rounded-xl border border-border bg-card p-7 shadow-[var(--shadow-card)]">
					<h1 className="font-bold font-display text-[20px] text-foreground leading-tight">
						Sign in
					</h1>
					<p className="mt-1.5 text-[13px] text-muted-foreground">
						Use the email and password for your account.
					</p>

					<LoginForm redirectTo={safeRedirect(requested)} />
				</div>
			</div>
		</main>
	);
}

/**
 * Only same-origin paths are followed. A protocol-relative `//evil.example`
 * is a valid URL to a browser and would otherwise send a freshly signed-in
 * user off-site with their session already written.
 */
function safeRedirect(value: string | undefined): Route {
	if (!value) return "/";
	if (!value.startsWith("/") || value.startsWith("//")) return "/";

	return value as Route;
}
