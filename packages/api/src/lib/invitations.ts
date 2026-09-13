import type { globalRole, invitationRole } from "@bfa-platform/db/schema";
import { TRPCError } from "@trpc/server";

import { type EmailSendResult, sendEmail } from "./email";
import {
	escapeHtml,
	renderCallToAction,
	renderEmailLayout,
	renderEmailParagraph,
} from "./email-layout";
import { buildInviteLink } from "./invitation-token";

export type GlobalRole = (typeof globalRole.enumValues)[number];
export type InvitationRole = (typeof invitationRole.enumValues)[number];

/** Structural shape of `ctx.caller` — kept local so this module stays testable. */
export type InvitingCaller = {
	profileId: string;
	globalRole: GlobalRole;
	waterPurveyorId: string | null;
};

export type InvitationTargetInput = {
	role: InvitationRole;
	/**
	 * Super-Admin only. Omitted or null provisions a brand-new water purveyor;
	 * a uuid targets an existing one. Ignored — and rejected — for every other
	 * role, whose tenant comes from their own profile.
	 */
	waterPurveyorId?: string | null;
	/**
	 * The name the new water purveyor will be created with. Required for a
	 * provisioning invitation and forbidden on every other kind, so the first
	 * administrator is never asked to name an organisation the Super-Admin has
	 * already named.
	 */
	proposedWaterPurveyorName?: string;
};

export type InvitationTarget = {
	associatedWpId: string | null;
	proposedWaterPurveyorName: string | null;
};

const WP_ROLES: readonly GlobalRole[] = [
	"wp_admin",
	"wp_sub_admin",
	"wp_employee",
];

/**
 * Decides which water purveyor an invitation belongs to.
 *
 * This is the tenant-authorization boundary for `createInvitation`, and it
 * deliberately takes the caller's resolved profile rather than anything the
 * client sent. A WP role's invitations land on their own WP and nowhere else:
 * a `waterPurveyorId` in the input is not quietly ignored but rejected, so a
 * cross-tenant attempt shows up as a `FORBIDDEN` in the logs instead of as a
 * silently rewritten row.
 *
 * Only a Super-Admin can produce a null `associated_wp_id`, which is what
 * provisions a new purveyor. The row policy enforces the same rule in the
 * database; this is the layer that gives the caller a typed error.
 */
export function resolveInvitationTarget(
	caller: InvitingCaller,
	input: InvitationTargetInput,
): InvitationTarget {
	if (caller.globalRole === "certifier") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Certifiers cannot send invitations",
		});
	}

	// Naming a purveyor into existence is a Super-Admin act. Refused outright
	// rather than dropped, so a WP role attempting it is a `FORBIDDEN` in the
	// logs instead of an invitation that quietly did something else.
	if (
		caller.globalRole !== "super_admin" &&
		input.proposedWaterPurveyorName !== undefined
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only a Super-Admin can create a water purveyor",
		});
	}

	const associatedWpId = resolveAssociatedWpId(caller, input);

	// A certifier invitation exists to attach an authorization to a purveyor.
	if (input.role === "certifier" && associatedWpId === null) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "A certifier invitation must name a water purveyor",
		});
	}

	if (associatedWpId !== null) {
		if (input.proposedWaterPurveyorName !== undefined) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"A water purveyor name belongs only on an invitation that creates one",
			});
		}

		return { associatedWpId, proposedWaterPurveyorName: null };
	}

	// A new purveyor is created by its first administrator redeeming the invite;
	// there is no other role that could bring one into existence.
	if (input.role !== "wp_admin") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"An invitation without a water purveyor provisions a new one, so its role must be wp_admin",
		});
	}

	const proposedWaterPurveyorName = input.proposedWaterPurveyorName?.trim();

	if (!proposedWaterPurveyorName) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Name the water purveyor this invitation will create",
		});
	}

	return { associatedWpId: null, proposedWaterPurveyorName };
}

function resolveAssociatedWpId(
	caller: InvitingCaller,
	input: InvitationTargetInput,
): string | null {
	if (caller.globalRole === "super_admin") {
		return input.waterPurveyorId ?? null;
	}

	if (!WP_ROLES.includes(caller.globalRole)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "This role cannot send invitations",
		});
	}

	if (!caller.waterPurveyorId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "This account is not attached to a water purveyor",
		});
	}

	if (
		input.waterPurveyorId !== undefined &&
		input.waterPurveyorId !== caller.waterPurveyorId
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "You can only invite people to your own water purveyor",
		});
	}

	return caller.waterPurveyorId;
}

/**
 * Why an invitation cannot be redeemed, or that it can.
 *
 * `is_redeemed` and `status` are checked separately even though redemption
 * writes both: they are two columns that can drift, and a token that is
 * redeemed by one measure and pending by the other must not be usable.
 */
export type InvitationState =
	| "valid"
	| "not_found"
	| "expired"
	| "redeemed"
	| "revoked";

export type EvaluatableInvitation = {
	status: "pending" | "redeemed" | "expired";
	isRedeemed: boolean;
	expiresAt: Date;
};

export function evaluateInvitation(
	invitation: EvaluatableInvitation | null | undefined,
	now: Date = new Date(),
): InvitationState {
	if (!invitation) return "not_found";
	if (invitation.isRedeemed || invitation.status === "redeemed") {
		return "redeemed";
	}
	if (invitation.status === "expired") return "expired";
	if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
	if (invitation.status !== "pending") return "revoked";

	return "valid";
}

/** How long an invite link stays usable when the caller does not say. */
export const DEFAULT_INVITATION_TTL_DAYS = 7;

export function invitationExpiry(
	days: number = DEFAULT_INVITATION_TTL_DAYS,
	now: Date = new Date(),
): Date {
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

const ROLE_LABELS: Record<InvitationRole, string> = {
	wp_admin: "Water Purveyor Administrator",
	wp_sub_admin: "Water Purveyor Sub-Administrator",
	wp_employee: "Water Purveyor Employee",
	certifier: "Certifier",
};

export type InvitationEmailInput = {
	invitationId: string;
	email: string;
	role: InvitationRole;
	secret: string;
	expiresAt: Date;
	waterPurveyorName: string | null;
	associatedWpId: string | null;
	invitedByProfileId: string;
};

export const INVITATION_EMAIL_SUBJECT =
	"You have been invited to the Backflow Assembly platform";

/**
 * The expiry as a reader would say it, pinned to UTC so every recipient and
 * every test sees the same instant written the same way.
 */
export function formatInvitationExpiry(expiresAt: Date): string {
	const formatted = new Intl.DateTimeFormat("en-US", {
		dateStyle: "long",
		timeStyle: "short",
		timeZone: "UTC",
	}).format(expiresAt);

	return `${formatted} UTC`;
}

/**
 * The invite email as a finished document, inside the shared layout.
 *
 * Pure, so its markup can be tested without a send. Every dynamic value is
 * escaped — the purveyor name was typed by a Super-Admin, and the link is
 * validated as an absolute http(s) URL before it becomes an `href`. The link is
 * the whole point of the message, so it appears as a button and again as
 * visible text: the console driver logs this HTML verbatim, and a developer
 * needs to be able to copy the URL out of that log line.
 */
export function renderInvitationEmail(input: {
	inviteLink: string;
	role: InvitationRole;
	waterPurveyorName: string | null;
	expiresAt: Date;
}): { subject: string; html: string } {
	const purveyor = input.waterPurveyorName
		? `<strong>${escapeHtml(input.waterPurveyorName)}</strong>`
		: "the Backflow Assembly platform";

	const bodyHtml = [
		renderEmailParagraph(
			`You have been invited to join ${purveyor} as a ${escapeHtml(ROLE_LABELS[input.role])}.`,
		),
		renderCallToAction({
			href: input.inviteLink,
			label: "Set up your account",
		}),
		renderEmailParagraph(
			`This invitation expires on ${escapeHtml(formatInvitationExpiry(input.expiresAt))}.`,
		),
		renderEmailParagraph(
			"If you were not expecting this invitation, you can ignore this email.",
			{ muted: true },
		),
	].join("\n");

	return {
		subject: INVITATION_EMAIL_SUBJECT,
		html: renderEmailLayout({
			title: INVITATION_EMAIL_SUBJECT,
			heading: "You have been invited",
			bodyHtml,
		}),
	};
}

/**
 * Renders and sends the invite email through the shared helper.
 *
 * Feature code calls this; it never builds a payload or logs a send of its own.
 */
export async function sendInvitationEmail(
	input: InvitationEmailInput,
): Promise<EmailSendResult & { inviteLink: string }> {
	const inviteLink = buildInviteLink(input.secret);
	const { subject, html } = renderInvitationEmail({
		inviteLink,
		role: input.role,
		waterPurveyorName: input.waterPurveyorName,
		expiresAt: input.expiresAt,
	});

	const result = await sendEmail(
		{
			to: input.email,
			subject,
			html,
			tags: [
				{ name: "type", value: "invitation" },
				{ name: "role", value: input.role },
				{ name: "invitation_id", value: input.invitationId },
			],
		},
		{
			event: "invitation_created",
			actorId: input.invitedByProfileId,
			wpId: input.associatedWpId,
			invitationId: input.invitationId,
		},
	);

	return { ...result, inviteLink };
}
