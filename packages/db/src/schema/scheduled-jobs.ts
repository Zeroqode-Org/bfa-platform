import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { bfaAssets } from "./bfa-assets";
import { customers } from "./customers";
import { jobStatus, jobType } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// Not in the original data model. Required because Vercel Cron is off the
// table (bfa-requirements) and job state must survive restarts. All writes
// go through the service-role scheduler process — no user-facing write path.
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobType: jobType("job_type").notNull(),
    bfaAssetId: uuid("bfa_asset_id").references(() => bfaAssets.id),
    customerId: uuid("customer_id").references(() => customers.id),
    waterPurveyorId: uuid("water_purveyor_id")
      .notNull()
      .references(() => waterPurveyors.id),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scheduled_jobs_water_purveyor_id_idx").on(table.waterPurveyorId),
    // the scheduler's claim query
    index("scheduled_jobs_status_run_at_idx").on(table.status, table.runAt),
  ],
).enableRLS();
