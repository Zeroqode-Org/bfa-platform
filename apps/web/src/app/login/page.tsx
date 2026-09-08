"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Minimal email/password sign-in. `createBrowserClient` persists the session in
 * cookies, which is what the tRPC context reads back through
 * `supabase.auth.getUser()` — so signing in here is enough for the Super-Admin
 * procedures to resolve a caller.
 *
 * Deliberately minimal: no sign-up, no password reset, and no role-aware
 * landing — everyone arrives at the workspace picker on `/`.
 */
export default function LoginPage() {
	const emailId = useId();
	const passwordId = useId();
	const errorId = useId();
	const router = useRouter();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setIsSubmitting(true);

		const supabase = createClient();
		const { error: signInError } = await supabase.auth.signInWithPassword({
			email: email.trim(),
			password,
		});

		if (signInError) {
			setError(signInError.message);
			setIsSubmitting(false);
			return;
		}

		// refresh() so the server re-reads the freshly written session cookies.
		router.replace("/");
		router.refresh();
	}

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

					<form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={emailId}>Email</Label>
							<Input
								id={emailId}
								name="email"
								type="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								autoComplete="email"
								placeholder="you@example.com"
								required
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor={passwordId}>Password</Label>
							<Input
								id={passwordId}
								name="password"
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="current-password"
								required
							/>
						</div>

						{error ? (
							<p
								id={errorId}
								role="alert"
								className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger"
							>
								<TriangleAlert
									className="mt-px size-4 shrink-0"
									aria-hidden="true"
								/>
								{error}
							</p>
						) : null}

						<Button
							type="submit"
							disabled={isSubmitting}
							className="mt-1 w-full"
						>
							{isSubmitting ? "Signing in…" : "Sign in"}
						</Button>
					</form>
				</div>
			</div>
		</main>
	);
}
