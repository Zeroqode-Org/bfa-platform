import { sql } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

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
		// When this job's outbound side effect was claimed — see 0012. Written
		// *before* the send and cleared only when the provider refuses, so a
		// crash-and-retry skips a send that may already have gone out rather than
		// mailing a customer the same notice twice.
		sentAt: timestamp("sent_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("scheduled_jobs_water_purveyor_id_idx").on(table.waterPurveyorId),
		// the scheduler's claim query
		index("scheduled_jobs_status_run_at_idx").on(table.status, table.runAt),
		// One live job per stage per assembly. A notice chain is derived entirely
		// from the asset's annual_test_date, so two pending reminders for one
		// asset are two copies of the same reminder and would both fire; two
		// clerks saving a date change at once is enough to create them. Partial
		// on the non-terminal statuses so a completed stage and next cycle's
		// pending one coexist, and on `bfa_asset_id is not null` so the
		// customer-scoped ag_renewal job is not squeezed into an asset-shaped
		// rule. Doubles as the lookup index for cancelling an asset's chain.
		uniqueIndex("scheduled_jobs_live_asset_job_type_key")
			.on(table.bfaAssetId, table.jobType)
			.where(
				sql`${table.status} in ('pending', 'running') and ${table.bfaAssetId} is not null`,
			),
	],
).enableRLS();
