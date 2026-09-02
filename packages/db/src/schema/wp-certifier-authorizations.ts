import { index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { certifiers } from "./certifiers";
import { authorizationStatus } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// Drives the certifier's WP selector.
export const wpCertifierAuthorizations = pgTable(
  "wp_certifier_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    certifierId: uuid("certifier_id")
      .notNull()
      .references(() => certifiers.id),
    waterPurveyorId: uuid("water_purveyor_id")
      .notNull()
      .references(() => waterPurveyors.id),
    authorizationStatus: authorizationStatus("authorization_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("wp_certifier_authorizations_water_purveyor_id_idx").on(table.waterPurveyorId),
    unique("wp_certifier_authorizations_certifier_id_water_purveyor_id_key").on(
      table.certifierId,
      table.waterPurveyorId,
    ),
  ],
).enableRLS();
