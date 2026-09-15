"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { TriangleAlert } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { clearImpersonationCookie } from "@/lib/clear-impersonation";
import { createClient } from "@/lib/supabase/client";

/**
 * Minimal email/password sign-in. `createBrowserClient` persists the session in
 * cookies, which is what the tRPC context reads back through
 * `supabase.auth.getUser()` — so signing in here is enough for the protected
 * procedures to resolve a caller.
 *
 * `redirectTo` is where the invite flow sends someone whose account already
 * existed. It is validated on the server before it reaches this component.
 * Everyone else goes to `/`, which resolves their role and forwards them to
 * their own dashboard — the role is never asked for, only looked up.
 */
export function LoginForm({ redirectTo }: { redirectTo: Route }) {
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

		// A new session never inherits an impersonation — the backstop for a
		// sign-out whose own clear never reached the server. Awaited, so the
		// cookie is gone before the route gate below reads it.
		await clearImpersonationCookie("sign_in");

		// refresh() so the server re-reads the freshly written session cookies.
		router.replace(redirectTo);
		router.refresh();
	}

	return (
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
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{error}
				</p>
			) : null}

			<Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
				{isSubmitting ? "Signing in…" : "Sign in"}
			</Button>
		</form>
	);
}
