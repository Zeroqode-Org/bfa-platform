import { db } from "@bfa-platform/db";
import {
	certifiers,
	invitations,
	profiles,
	waterPurveyors,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { and, eq, gt } from "drizzle-orm";

import { type AuthAdmin, createAuthAdmin } from "./auth-admin";
import { hashInvitationSecret } from "./invitation-token";
import { evaluateInvitation, type InvitationRole } from "./invitations";

/**
 * Invite redemption — the one path that creates an account on this platform.
 *
 * The token is resolved server-side through the privileged database connection,
 * never through a client-side query. `invitations` carries no policy that would
 * let an anonymous or authenticated role read a row it does not already own, so
 * tokens are not enumerable from the browser. The Supabase service-role client
 * appears here too, for the half of the work only it can do — creating and, on
 * rollback, deleting the `auth.users` record.
 *
 * Two stores are written and they cannot share a transaction: `auth.users` sits
 * behind Supabase's Auth API. The order is chosen so a failure never leaves a
 * usable half-account — the auth user is created first, every public row is
 * written in one database transaction, and a transaction that rolls back takes
 * the auth user with it. The reverse order would strand a profile with no way
 * to sign in, which no compensating write could clean up as safely.
 */

/** What the first-login form has to collect, decided before it renders. */
export type RedemptionMode =
	/** Set a password and complete a profile. */
	| "new_profile"
	/** As above, plus the company name that becomes the new water purveyor. */
	| "new_water_purveyor"
	/** Nothing: an existing certifier gains one more authorization. */
	| "existing_certifier";

export type PublicInvitation = {
	id: string;
	email: string;
	role: InvitationRole;
	associatedWpId: string | null;
	/**
	 * The purveyor this invitation is for: the existing one's name, or — when the
	 * invitation provisions a purveyor — the name the Super-Admin gave it. Either
	 * way the invitee reads a name rather than typing one.
	 */
	waterPurveyorName: string | null;
	/**
	 * Internal or external, for the authorization redemption creates. Null on
	 * non-certifier invitations and on certifier ones sent before the choice
	 * existed, which redeem as external.
	 */
	certifierType: "internal" | "external" | null;
	expiresAt: Date;
};

export type InvitationInspection =
	| { state: "not_found" }
	| { state: "expired" }
	| { state: "redeemed" }
	| { state: "revoked" }
	/** The address already has an account this invitation cannot extend. */
	| { state: "email_in_use"; invitation: PublicInvitation }
	| {
			state: "valid";
			mode: RedemptionMode;
			invitation: PublicInvitation;
			/**
			 * The account this address already has, on the `existing_certifier`
			 * path; null when redemption will create one. Carried out of the
			 * inspection so redemption does not scan the auth user list twice.
			 */
			existingUserId: string | null;
	  };

export type RedemptionDeps = { authAdmin: AuthAdmin };

type InvitationRow = {
	id: string;
	email: string;
	role: InvitationRole;
	status: "pending" | "redeemed" | "expired";
	isRedeemed: boolean;
	expiresAt: Date;
	associatedWpId: string | null;
	waterPurveyorName: string | null;
	proposedWaterPurveyorName: string | null;
	certifierType: "internal" | "external" | null;
};

async function loadInvitation(secret: string): Promise<InvitationRow | null> {
	const [row] = await db
		.select({
			id: invitations.id,
			email: invitations.email,
			role: invitations.role,
			status: invitations.status,
			isRedeemed: invitations.isRedeemed,
			expiresAt: invitations.expiresAt,
			associatedWpId: invitations.associatedWpId,
			waterPurveyorName: waterPurveyors.companyName,
			proposedWaterPurveyorName: invitations.proposedWaterPurveyorName,
			certifierType: invitations.certifierType,
		})
		.from(invitations)
		.leftJoin(waterPurveyors, eq(waterPurveyors.id, invitations.associatedWpId))
		.where(eq(invitations.token, hashInvitationSecret(secret)))
		.limit(1);

	return row ?? null;
}

function toPublic(row: InvitationRow): PublicInvitation {
	return {
		id: row.id,
		email: row.email,
		role: row.role,
		associatedWpId: row.associatedWpId,
		// One field for the screen to render, whichever kind of invitation it is.
		waterPurveyorName: row.waterPurveyorName ?? row.proposedWaterPurveyorName,
		certifierType: row.certifierType,
		expiresAt: row.expiresAt,
	};
}

async function findCertifierByProfileId(
	executor: typeof db | Tx,
	profileId: string,
) {
	const [row] = await executor
		.select({ id: certifiers.id })
		.from(certifiers)
		.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
		.where(
			and(
				eq(certifiers.profileId, profileId),
				eq(profiles.globalRole, "certifier"),
			),
		)
		.limit(1);

	return row ?? null;
}

/**
 * Resolves a token to what the first-login screen should render. Reads only —
 * an invitation is not consumed by being looked at, so a refreshed page or a
 * link opened twice before the form is submitted still works.
 */
export async function inspectInvitation(
	secret: string,
	deps: RedemptionDeps = { authAdmin: createAuthAdmin() },
	now: Date = new Date(),
): Promise<InvitationInspection> {
	const row = await loadInvitation(secret);
	const state = evaluateInvitation(row, now);

	if (!row || state !== "valid") {
		return { state: state === "valid" ? "not_found" : state };
	}

	const existingUserId = await deps.authAdmin.findUserIdByEmail(row.email);

	if (!existingUserId) {
		return {
			state: "valid",
			mode: row.associatedWpId === null ? "new_water_purveyor" : "new_profile",
			invitation: toPublic(row),
			existingUserId: null,
		};
	}

	// The address already has an account. The one invitation that can extend an
	// existing account is a second purveyor authorizing a certifier who is
	// already on the platform — anything else would mean rewriting a profile
	// somebody is already using.
	const existingCertifier = await findCertifierByProfileId(db, existingUserId);

	if (row.role === "certifier" && existingCertifier) {
		return {
			state: "valid",
			mode: "existing_certifier",
			invitation: toPublic(row),
			existingUserId: existingUserId,
		};
	}

	return { state: "email_in_use", invitation: toPublic(row) };
}

export type RedeemInvitationInput = {
	secret: string;
	/** Required for every mode but `existing_certifier`. */
	password?: string;
	fullName?: string;
	/** Required when the invited role is `certifier` and the profile is new. */
	certifier?: {
		company: string;
		idNumber: string;
		licenseExpirationDate: string;
	};
};

export type RedeemInvitationResult = {
	mode: RedemptionMode;
	profileId: string;
	email: string;
	globalRole: InvitationRole;
	waterPurveyorId: string | null;
	/** False when the account already existed — the caller must sign in. */
	credentialsCreated: boolean;
};

export type RedemptionFailure =
	| "not_found"
	| "expired"
	| "redeemed"
	| "revoked"
	| "email_in_use"
	| "invalid_input";

export class RedemptionError extends Error {
	constructor(
		readonly reason: RedemptionFailure,
		message: string,
	) {
		super(message);
		this.name = "RedemptionError";
	}
}

export async function redeemInvitation(
	input: RedeemInvitationInput,
	deps: RedemptionDeps = { authAdmin: createAuthAdmin() },
	now: Date = new Date(),
): Promise<RedeemInvitationResult> {
	const inspection = await inspectInvitation(input.secret, deps, now);

	if (inspection.state !== "valid") {
		throw new RedemptionError(
			inspection.state,
			redemptionMessage(inspection.state),
		);
	}

	const { mode, invitation, existingUserId } = inspection;

	// The auth user is created before the transaction opens, so the transaction
	// stays short and holds no row lock across a network call to the Auth server.
	let createdAuthUserId: string | null = null;
	let profileId: string;

	if (mode === "existing_certifier") {
		if (!existingUserId) {
			throw new RedemptionError(
				"not_found",
				"The account for this invitation no longer exists",
			);
		}

		profileId = existingUserId;
	} else {
		const password = requireField(input.password, "a password");
		requireField(input.fullName, "your full name");
		createdAuthUserId = await deps.authAdmin.createUser({
			email: invitation.email,
			password,
		});
		profileId = createdAuthUserId;
	}

	try {
		const result = await db.transaction(async (tx) => {
			// Claiming the invitation is the first write and it is conditional, so
			// two redemptions racing on the same link cannot both proceed — the
			// loser matches no row and the whole transaction rolls back.
			const [claimed] = await tx
				.update(invitations)
				.set({ isRedeemed: true, status: "redeemed" })
				.where(
					and(
						eq(invitations.id, invitation.id),
						eq(invitations.isRedeemed, false),
						eq(invitations.status, "pending"),
						gt(invitations.expiresAt, now),
					),
				)
				.returning({ id: invitations.id });

			if (!claimed) {
				throw new RedemptionError(
					"redeemed",
					"This invitation has already been used",
				);
			}

			if (mode === "existing_certifier") {
				return await addSecondPurveyor(tx, profileId, invitation);
			}

			return await createAccount(tx, profileId, invitation, input, mode);
		});

		console.log(
			JSON.stringify({
				event: "invitation_redeemed",
				actor_id: result.profileId,
				invitation_id: invitation.id,
				mode: result.mode,
				role: result.globalRole,
				wp_id: invitation.associatedWpId ?? result.waterPurveyorId,
				timestamp: new Date().toISOString(),
			}),
		);

		return result;
	} catch (error) {
		// The transaction rolled back, so nothing in `public` survived it. The
		// auth user is the only write outside that boundary — undo it, or the
		// address is permanently unable to redeem a replacement invitation.
		if (createdAuthUserId) {
			await deleteAuthUserQuietly(deps, createdAuthUserId, invitation.id);
		}

		console.log(
			JSON.stringify({
				event: "invitation_redemption_failed",
				invitation_id: invitation.id,
				mode,
				reason: error instanceof RedemptionError ? error.reason : "error",
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			}),
		);

		throw error;
	}
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Second-WP path. The certifier already has a profile and a `certifiers` row —
 * neither is touched. Only the authorization is added, and `onConflictDoNothing`
 * makes a duplicate invitation for a purveyor they already serve a no-op rather
 * than a unique-constraint failure. That includes its internal/external type:
 * an existing authorization keeps the one it has, which the purveyor changes
 * from the Certifiers screen rather than by inviting again.
 */
async function addSecondPurveyor(
	tx: Tx,
	profileId: string,
	invitation: PublicInvitation,
): Promise<RedeemInvitationResult> {
	const certifier = await findCertifierByProfileId(tx, profileId);

	if (!certifier || invitation.associatedWpId === null) {
		throw new RedemptionError(
			"invalid_input",
			"This invitation cannot be added to the existing account",
		);
	}

	await tx
		.insert(wpCertifierAuthorizations)
		.values({
			certifierId: certifier.id,
			waterPurveyorId: invitation.associatedWpId,
			authorizationStatus: "active",
		})
		.onConflictDoNothing();

	return {
		mode: "existing_certifier",
		profileId,
		email: invitation.email,
		globalRole: "certifier",
		waterPurveyorId: null,
		credentialsCreated: false,
	};
}

async function createAccount(
	tx: Tx,
	profileId: string,
	invitation: PublicInvitation,
	input: RedeemInvitationInput,
	mode: RedemptionMode,
): Promise<RedeemInvitationResult> {
	// A null `associated_wp_id` is what provisions a purveyor: the row and its
	// first administrator are created together or not at all.
	let waterPurveyorId = invitation.associatedWpId;

	if (mode === "new_water_purveyor") {
		// The name came from the Super-Admin at invite time and rode along on the
		// invitation, so there is nothing to ask the first administrator for. A
		// check constraint on `invitations` keeps it from ever being absent here;
		// this guard is what turns a violated invariant into a readable error
		// instead of a null-constraint failure two statements later.
		const companyName = invitation.waterPurveyorName?.trim();

		if (!companyName) {
			throw new RedemptionError(
				"invalid_input",
				"This invitation does not name the water purveyor it should create",
			);
		}

		const [purveyor] = await tx
			.insert(waterPurveyors)
			.values({ companyName })
			.returning({ id: waterPurveyors.id });

		if (!purveyor) throw new Error("Water purveyor insert returned no row");

		waterPurveyorId = purveyor.id;
	}

	const isCertifier = invitation.role === "certifier";

	await tx.insert(profiles).values({
		id: profileId,
		// Certifiers are not tenants of a purveyor; their reach comes from
		// `wp_certifier_authorizations`, not from this column.
		waterPurveyorId: isCertifier ? null : waterPurveyorId,
		fullName: input.fullName?.trim() ?? null,
		globalRole: invitation.role,
	});

	if (isCertifier) {
		if (!waterPurveyorId) {
			throw new RedemptionError(
				"invalid_input",
				"A certifier invitation must name a water purveyor",
			);
		}

		const details = input.certifier;

		if (!details) {
			throw new RedemptionError(
				"invalid_input",
				"Company, certifier ID and license expiration date are required",
			);
		}

		const [certifier] = await tx
			.insert(certifiers)
			.values({
				profileId,
				company: requireField(details.company, "your company"),
				idNumber: requireField(details.idNumber, "your certifier ID number"),
				licenseExpirationDate: requireField(
					details.licenseExpirationDate,
					"your license expiration date",
				),
			})
			.returning({ id: certifiers.id });

		if (!certifier) throw new Error("Certifier insert returned no row");

		await tx.insert(wpCertifierAuthorizations).values({
			certifierId: certifier.id,
			waterPurveyorId,
			authorizationStatus: "active",
			certifierType: invitation.certifierType ?? "external",
		});
	}

	return {
		mode,
		profileId,
		email: invitation.email,
		globalRole: invitation.role,
		waterPurveyorId: isCertifier ? null : waterPurveyorId,
		credentialsCreated: true,
	};
}

async function deleteAuthUserQuietly(
	deps: RedemptionDeps,
	userId: string,
	invitationId: string,
) {
	try {
		await deps.authAdmin.deleteUser(userId);
	} catch (cleanupError) {
		// Nothing further to try. Log it loudly — an orphaned auth user with no
		// profile cannot sign in past `resolveCaller`, but it does block the
		// address from redeeming a replacement invitation.
		console.log(
			JSON.stringify({
				event: "invitation_redemption_cleanup_failed",
				actor_id: userId,
				invitation_id: invitationId,
				error:
					cleanupError instanceof Error
						? cleanupError.message
						: String(cleanupError),
				timestamp: new Date().toISOString(),
			}),
		);
	}
}

function requireField(value: string | undefined, label: string): string {
	const trimmed = value?.trim();

	if (!trimmed) {
		throw new RedemptionError("invalid_input", `Please provide ${label}.`);
	}

	return trimmed;
}

export function redemptionMessage(
	state: Exclude<InvitationInspection["state"], "valid">,
): string {
	switch (state) {
		case "expired":
			return "This invitation has expired. Ask whoever invited you to send a new one.";
		case "redeemed":
			return "This invitation has already been used. Sign in with the account it created.";
		case "revoked":
			return "This invitation is no longer valid. Ask whoever invited you to send a new one.";
		case "email_in_use":
			return "An account already exists for this email address. Sign in instead.";
		default:
			return "This invitation link is not valid. Check that you copied the whole link.";
	}
}
