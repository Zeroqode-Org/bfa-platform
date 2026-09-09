import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { invitationRole, invitationStatus } from "./enums";
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
	],
).enableRLS();
