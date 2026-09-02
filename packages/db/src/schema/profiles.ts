import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { activeBlocked, globalRole } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// `id` equals `auth.users.id` (Supabase-managed, cross-schema — the FK to
// auth.users is enforced by Supabase itself, not modeled here). Rows are
// created only by the invite-redemption server action via the service-role
// client, never inserted through a client-facing procedure.
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey(),
    waterPurveyorId: uuid("water_purveyor_id").references(() => waterPurveyors.id),
    fullName: text("full_name"),
    globalRole: globalRole("global_role").notNull(),
    status: activeBlocked("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("profiles_water_purveyor_id_idx").on(table.waterPurveyorId)],
).enableRLS();
