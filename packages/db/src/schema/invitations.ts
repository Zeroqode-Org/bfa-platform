import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { certifierType, invitationRole, invitationStatus } from "./enums";
import { profiles } from "./profiles";
import { waterPurveyors } from "./water-purveyors";

// Token redemption runs through a server action with the service-role key —
// there is no anonymous RLS read path, so tokens are not enumerable. The stored
// `token` is the SHA-256 digest of the secret carried in the invite link, never
// the secret itself.
export const invitations = pgTable(
	"invitations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		email: text("email").notNull(),
		role: invitationRole("role").notNull(),
		token: text("token").notNull().unique(),
		status: invitationStatus("status").notNull().default("pending"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		// null when Super-Admin invites a brand-new WP
		associatedWpId: uuid("associated_wp_id").references(
			() => waterPurveyors.id,
		),
		// The name of the water purveyor a null-`associated_wp_id` invitation will
		// create. The Super-Admin types it when inviting, so the first admin is
		// never asked to name their own organisation on the way in; redemption
		// reads it from here. Null on every other kind of invitation.
		proposedWaterPurveyorName: text("proposed_water_purveyor_name"),
		// Internal or external, as the purveyor chose when inviting a certifier;
		// redemption copies it onto the authorization it creates. Null on every
		// other role — and on certifier invitations from before the choice
		// existed, which redeem as external.
		certifierType: certifierType("certifier_type"),
		invitedByProfileId: uuid("invited_by_profile_id").references(
			() => profiles.id,
		),
		isRedeemed: boolean("is_redeemed").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		// Every WP-role row policy on this table filters on `associated_wp_id`.
		index("invitations_associated_wp_id_idx").on(table.associatedWpId),
		// The two shapes an invitation may take, as a constraint rather than a
		// convention. A null purveyor means "provision one", which only a first
		// administrator can do and which needs a name to create it with; anything
		// else names an existing purveyor and must not carry a name at all. The
		// procedure layer rejects both mistakes with a typed error first — this is
		// what stops a row that skipped it from reaching the table.
		check(
			"invitations_new_wp_name_shape",
			sql`(
				${table.associatedWpId} is null
				and ${table.role} = 'wp_admin'
				and ${table.proposedWaterPurveyorName} is not null
				and length(btrim(${table.proposedWaterPurveyorName})) > 0
			) or (
				${table.associatedWpId} is not null
				and ${table.proposedWaterPurveyorName} is null
			)`,
		),
		// Only a certifier invitation may say internal or external.
		check(
			"invitations_certifier_type_role",
			sql`${table.certifierType} is null or ${table.role} = 'certifier'`,
		),
	],
).enableRLS();
