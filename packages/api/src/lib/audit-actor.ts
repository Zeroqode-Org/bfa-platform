/**
 * Who a structured audit line attributes an action to.
 *
 * Two identities, because impersonation makes them differ. `actorId` is always
 * the real signed-in account — the Super-Admin, while they impersonate — and is
 * what `actor_id` means in every log line on the platform. `effectiveProfileId`
 * is the identity the action was performed as, which is the impersonated WP
 * admin while impersonating and the same account otherwise.
 *
 * Feature routers build this from the procedure context with `auditActor(ctx)`
 * and never from `ctx.caller.profileId` alone: that is the *effective* caller,
 * and attributing a Super-Admin's change to the purveyor admin they were acting
 * as would put the wrong person in the audit trail. A structural test
 * (`routers/audit-attribution.test.ts`) keeps it that way.
 */
export type AuditActor = {
	/** The real signed-in account. */
	actorId: string;
	/** The account the action was performed as. Equal to `actorId` unless impersonating. */
	effectiveProfileId: string;
};

export function auditActor(ctx: {
	actor: { profileId: string };
	caller: { profileId: string };
}): AuditActor {
	return {
		actorId: ctx.actor.profileId,
		effectiveProfileId: ctx.caller.profileId,
	};
}

/** The two log fields, in the platform's snake_case log vocabulary. */
export function auditActorFields(actor: AuditActor | null | undefined): {
	actor_id: string | null;
	effective_profile_id: string | null;
} {
	return {
		actor_id: actor?.actorId ?? null,
		effective_profile_id: actor?.effectiveProfileId ?? null,
	};
}
