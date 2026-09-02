import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { customerStatus, rateCategory } from "./enums";
import { waterPurveyors } from "./water-purveyors";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    waterPurveyorId: uuid("water_purveyor_id")
      .notNull()
      .references(() => waterPurveyors.id),
    accountNumber: text("account_number"),
    name: text("name").notNull(),
    address: text("address"),
    email: text("email").notNull(),
    rateCategory: rateCategory("rate_category").notNull().default("standard"),
    agRenewalDate: date("ag_renewal_date"),
    // suspended holds the asset's whole notice pipeline
    status: customerStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("customers_water_purveyor_id_idx").on(table.waterPurveyorId)],
).enableRLS();
