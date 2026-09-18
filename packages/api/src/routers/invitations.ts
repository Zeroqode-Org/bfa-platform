import { db } from "@bfa-platform/db";
import { invitations, waterPurveyors } from "@bfa-platform/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router, TRPCError } from "../index";
import { auditActor, auditActorFields } from "../lib/audit-actor";
import { INVITATION_FIELD_LIMITS } from "../lib/invitation-field-limits";
import {
	createInvitationToken,
	hashInvitationSecret,
} from "../lib/invitation-token";
import {
	DEFAULT_INVITATION_TTL_DAYS,
	invitationExpiry,
	resolveInvitationTarget,
	sendInvitationEmail,
} from "../lib/invitations";

const createInvitationInput = z.object({
	// Normalised before validation so a pasted address with a stray space or a
	// capitalised domain is accepted, and so the stored address matches the one
	// redemption later looks up.
	email: z
		.string()
		.trim()
		.toLowerCase()
		.pipe(z.email().max(INVITATION_FIELD_LIMITS.email)),
	role: z.enum(["wp_admin", "wp_sub_admin", "wp_employee", "certifier"]),
	/**
	 * Super-Admin only, and never an authorization input: a WP role's tenant is
	 * read from their own profile, and passing someone else's is rejected rather
	 * than ignored. Explicit null provisions a brand-new purveyor.
	 */
	waterPurveyorId: z.uuid().nullish(),
	/**
	 * The name of the water purveyor this invitation will create. Super-Admin
	 * only, required when `waterPurveyorId` is null and rejected otherwise —
	 * `resolveInvitationTarget` decides which, and a check constraint on the
	 * table refuses any row that got past it.
	 */
	proposedWaterPurveyorName: z
		.string()
		.trim()
		.min(1)
		.max(INVITATION_FIELD_LIMITS.proposedWaterPurveyorName)
		.optional(),
	expiresInDays: z.int().min(1).max(30).default(DEFAULT_INVITATION_TTL_DAYS),
});

export const invitationsRouter = router({
	/**
	 * Creates one invitation and sends its link.
	 *
	 * The row is written through the privileged Drizzle connection, so the
	 * procedure — not the row policy — is the authorization boundary here;
	 * `resolveInvitationTarget` is that boundary, and the matching policies in
	 * `0001_invitation_onboarding_policies` enforce the same rule for anything
	 * that ever reaches the table through PostgREST.
	 *
	 * The token stored is a SHA-256 digest; the secret exists only in the email.
	 * If the send fails the invitation is deleted, because a row nobody holds a
	 * link to is an invitation that can never be redeemed and never expires
	 * visibly — it just sits there looking pending.
	 */
	createInvitation: protectedProcedure
		.input(createInvitationInput)
		.mutation(async ({ ctx, input }) => {
			const { associatedWpId, proposedWaterPurveyorName } =
				resolveInvitationTarget(ctx.caller, {
					role: input.role,
					// `nullish` collapses "absent" and "explicitly null" in Zod's output,
					// so read the raw key to keep the distinction the resolver needs.
					waterPurveyorId:
						"waterPurveyorId" in input
							? (input.waterPurveyorId ?? null)
							: undefined,
					proposedWaterPurveyorName: input.proposedWaterPurveyorName,
				});

			// The name shown in the email: the existing purveyor's, or — for an
			// invitation that creates one — the name it will be created with.
			const purveyorName = associatedWpId
				? await loadPurveyorName(associatedWpId)
				: proposedWaterPurveyorName;

			const { secret, tokenHash } = createInvitationToken();
			const expiresAt = invitationExpiry(input.expiresInDays);

			const [invitation] = await db
				.insert(invitations)
				.values({
					email: input.email,
					role: input.role,
					token: tokenHash,
					status: "pending",
					expiresAt,
					associatedWpId,
					proposedWaterPurveyorName,
					invitedByProfileId: ctx.caller.profileId,
					isRedeemed: false,
				})
				.returning({
					id: invitations.id,
					email: invitations.email,
					role: invitations.role,
					expiresAt: invitations.expiresAt,
					associatedWpId: invitations.associatedWpId,
					proposedWaterPurveyorName: invitations.proposedWaterPurveyorName,
				});

			if (!invitation) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Invitation insert returned no row",
				});
			}

			console.log(
				JSON.stringify({
					event: "invitation_created",
					...auditActorFields(auditActor(ctx)),
					invitation_id: invitation.id,
					recipient: invitation.email,
					role: invitation.role,
					wp_id: invitation.associatedWpId,
					proposed_wp_name: invitation.proposedWaterPurveyorName,
					expires_at: invitation.expiresAt.toISOString(),
					timestamp: new Date().toISOString(),
				}),
			);

			let emailDelivery: "sent" | "logged";

			try {
				const delivery = await sendInvitationEmail({
					invitationId: invitation.id,
					email: invitation.email,
					role: invitation.role,
					secret,
					expiresAt: invitation.expiresAt,
					waterPurveyorName: purveyorName,
					associatedWpId: invitation.associatedWpId,
					actor: auditActor(ctx),
				});
				// The browser needs the user-facing outcome, not the configured driver
				// name. A provider accepted the message for delivery; console has the
				// link only in its structured server log.
				emailDelivery = delivery.driver === "provider" ? "sent" : "logged";
			} catch (error) {
				await db
					.delete(invitations)
					.where(eq(invitations.token, hashInvitationSecret(secret)));

				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "The invitation could not be sent",
					cause: error,
				});
			}

			// The secret is deliberately absent from the response. It reaches the
			// invitee through the email helper and nowhere else — including the
			// console driver's log line, which is the developer's copy of it.
			return {
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				expiresAt: invitation.expiresAt,
				waterPurveyorId: invitation.associatedWpId,
				proposedWaterPurveyorName: invitation.proposedWaterPurveyorName,
				emailDelivery,
			};
		}),
});

async function loadPurveyorName(waterPurveyorId: string) {
	const [row] = await db
		.select({ companyName: waterPurveyors.companyName })
		.from(waterPurveyors)
		.where(eq(waterPurveyors.id, waterPurveyorId))
		.limit(1);

	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Water purveyor not found",
		});
	}

	return row.companyName;
}
