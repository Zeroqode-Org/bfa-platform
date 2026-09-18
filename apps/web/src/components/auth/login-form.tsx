"use client";

import { Button } from "@bfa-platform/ui/components/button";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import { composeRules, email, required } from "@bfa-platform/ui/lib/validation";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { clearImpersonationCookie } from "@/lib/clear-impersonation";
import { createClient } from "@/lib/supabase/client";

/**
 * Shown when the password was accepted but the session could not be finished
 * safely. Says nothing about cookies or impersonation — only what to do.
 */
export const SIGN_IN_INCOMPLETE_MESSAGE =
	"We couldn't finish signing you in. Check your connection and try again.";

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
 *
 * A failed sign-in is a form-level message, not a field one: Supabase answers
 * "invalid login credentials" without saying which half was wrong, and
 * guessing would tell an attacker which addresses have accounts.
 */
export function LoginForm({ redirectTo }: { redirectTo: Route }) {
	const router = useRouter();

	const [values, setValues] = useState({ email: "", password: "" });
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const validation = useFormValidation({
		values,
		rules: {
			email: composeRules(required("Email is required."), email()),
			password: required("Password is required."),
		},
	});

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		if (!validation.validate()) return;

		setIsSubmitting(true);

		const supabase = createClient();
		const { error: signInError } = await supabase.auth.signInWithPassword({
			email: values.email.trim(),
			password: values.password,
		});

		if (signInError) {
			setError(signInError.message);
			setIsSubmitting(false);
			return;
		}

		// Tidy away any impersonation cookie left by an earlier session before
		// entering the app. This is housekeeping, not what keeps an old
		// impersonation from resuming: the server binds that cookie to the auth
		// session it was issued in, and this sign-in has a new one, so the route
		// gate ignores the cookie regardless (`resolveEffectiveCaller`).
		//
		// If the clear did not go through, the form still does not navigate. It
		// says so and lets the person retry, and drops the new session locally
		// so a retry starts clean. Neither step is load-bearing for security —
		// both can fail without an old impersonation coming back.
		if (!(await clearImpersonationCookie("sign_in"))) {
			await supabase.auth.signOut({ scope: "local" }).catch(() => {});
			setError(SIGN_IN_INCOMPLETE_MESSAGE);
			setIsSubmitting(false);
			return;
		}

		// refresh() so the server re-reads the freshly written session cookies.
		router.replace(redirectTo);
		router.refresh();
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="mt-6 flex flex-col gap-4"
			noValidate
		>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId("email")}>Email</Label>
				<Input
					{...validation.controlProps("email")}
					name="email"
					type="email"
					value={values.email}
					onChange={(event) =>
						setValues((current) => ({ ...current, email: event.target.value }))
					}
					autoComplete="email"
					placeholder="you@example.com"
				/>
				<FieldError {...validation.errorProps("email")} />
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId("password")}>Password</Label>
				<Input
					{...validation.controlProps("password")}
					name="password"
					type="password"
					value={values.password}
					onChange={(event) =>
						setValues((current) => ({
							...current,
							password: event.target.value,
						}))
					}
					autoComplete="current-password"
				/>
				<FieldError {...validation.errorProps("password")} />
			</div>

			<FormError message={error} />

			<Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
				{isSubmitting ? "Signing in…" : "Sign in"}
			</Button>
		</form>
	);
}
