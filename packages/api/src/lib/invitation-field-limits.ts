/**
 * Maximum lengths for the `createInvitation` text fields.
 *
 * A module of its own, importing nothing, so the two invite dialogs can check
 * the same numbers inline that `routers/invitations.ts` builds its Zod shape
 * from, without importing a router (and its database) into the browser.
 */
export const INVITATION_FIELD_LIMITS = {
	email: 254,
	proposedWaterPurveyorName: 200,
} as const;
