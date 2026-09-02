import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { invitationRole, invitationStatus } from "./enums";
import { profiles } from "./profiles";
import { waterPurveyors } from "./water-purveyors";

// Token redemption runs through a server action with the service-role key —
// there is no anonymous RLS read path, so tokens are not enumerable.
export const invitations = pgTable("invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  role: invitationRole("role").notNull(),
  token: text("token").notNull().unique(),
  status: invitationStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // null when Super-Admin invites a brand-new WP
  associatedWpId: uuid("associated_wp_id").references(() => waterPurveyors.id),
  invitedByProfileId: uuid("invited_by_profile_id").references(() => profiles.id),
  isRedeemed: boolean("is_redeemed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
