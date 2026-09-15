"use server";

import {
	RedemptionError,
	redeemInvitation,
} from "@bfa-platform/api/lib/invitation-redemption";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";

import { landingRouteFor } from "@/lib/landing-route";
import {
	MIN_PASSWORD_LENGTH,
	REDEEM_FIELD_LIMITS,
} from "@/lib/redeem-field-limits";
import { createClient } from "@/lib/supabase/server";

/**
 * Redemption entry point for the first-login screen.
 *
 * A server action, not a tRPC mutation: the caller has no session yet, so there
 * is no `ctx.caller` to resolve, and the whole point of the flow is that the
 * token — not a signed-in identity — is the credential. The token is resolved
 * with the privileged connection inside `redeemInvitation`; nothing about the
 * invitation is readable from the browser.
 */

export type RedeemState = { error: string | null };

const redeemSchema = z
	.object({
		secret: z.string().min(1),
		mode: z.enum(["new_profile", "new_water_purveyor", "existing_certifier"]),
		fullName: z.string().trim().max(REDEEM_FIELD_LIMITS.fullName).optional(),
		password: z.string().max(REDEEM_FIELD_LIMITS.password).optional(),
		confirmPassword: z.string().max(REDEEM_FIELD_LIMITS.password).optional(),
		certifierCompany: z
			.string()
			.trim()
			.max(REDEEM_FIELD_LIMITS.certifierCompany)
			.optional(),
		certifierIdNumber: z
			.string()
			.trim()
			.max(REDEEM_FIELD_LIMITS.certifierIdNumber)
			.optional(),
		licenseExpirationDate: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD")
			.optional(),
		isCertifier: z.enum(["yes", "no"]),
	})
	.superRefine((value, ctx) => {
		if (value.mode === "existing_certifier") return;

		if (!value.fullName) {
			ctx.addIssue({ code: "custom", message: "Enter your full name" });
		}

		if (!value.password || value.password.length < MIN_PASSWORD_LENGTH) {
			ctx.addIssue({
				code: "custom",
				message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
			});
		} else if (value.password !== value.confirmPassword) {
			ctx.addIssue({ code: "custom", message: "The passwords do not match" });
		}

		if (value.isCertifier === "yes") {
			if (!value.certifierCompany) {
				ctx.addIssue({ code: "custom", message: "Enter your company" });
			}
			if (!value.certifierIdNumber) {
				ctx.addIssue({
					code: "custom",
					message: "Enter your certifier ID number",
				});
			}
			if (!value.licenseExpirationDate) {
				ctx.addIssue({
					code: "custom",
					message: "Enter your license expiration date",
				});
			}
		}
	});

export async function redeemInvitationAction(
	_previous: RedeemState,
	formData: FormData,
): Promise<RedeemState> {
	const parsed = redeemSchema.safeParse(Object.fromEntries(formData));

	if (!parsed.success) {
		return {
			error: parsed.error.issues[0]?.message ?? "Check the form and try again.",
		};
	}

	const input = parsed.data;
	let result: Awaited<ReturnType<typeof redeemInvitation>>;

	try {
		result = await redeemInvitation({
			secret: input.secret,
			password: input.password,
			fullName: input.fullName,
			certifier:
				input.isCertifier === "yes" &&
				input.certifierCompany &&
				input.certifierIdNumber &&
				input.licenseExpirationDate
					? {
							company: input.certifierCompany,
							idNumber: input.certifierIdNumber,
							licenseExpirationDate: input.licenseExpirationDate,
						}
					: undefined,
		});
	} catch (error) {
		if (error instanceof RedemptionError) {
			return { error: error.message };
		}

		// Never surface the underlying message — it can carry database or Auth
		// detail that the person redeeming an invitation has no business seeing.
		console.log(
			JSON.stringify({
				event: "invitation_redemption_error",
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			}),
		);

		return {
			error: "Something went wrong setting up your account. Try again.",
		};
	}

	const destination = landingRouteFor(result.globalRole);

	// The account already existed, so this flow never held its password. Send
	// them to sign in; the new authorization is already on their account, and
	// they will not be asked to complete a profile again.
	if (!result.credentialsCreated) {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();

		redirect(
			user?.id === result.profileId
				? destination
				: (`/login?redirect=${encodeURIComponent(destination)}` as Route),
		);
	}

	const supabase = await createClient();
	const { error: signInError } = await supabase.auth.signInWithPassword({
		email: result.email,
		password: input.password ?? "",
	});

	// The account exists either way. A failed sign-in here is an inconvenience,
	// not a failed redemption — send them to the login screen rather than
	// implying their invitation did not work.
	redirect(
		signInError
			? (`/login?redirect=${encodeURIComponent(destination)}` as Route)
			: destination,
	);
}
