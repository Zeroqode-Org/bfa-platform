import { sql } from "drizzle-orm";
import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

import { repairCompanyStatus } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// Read by the failure workflow at send time, joined on water_purveyor_id.
// No FK from test_submissions.
export const repairCompanies = pgTable(
	"repair_companies",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		companyName: text("company_name").notNull(),
		phone: text("phone"),
		email: text("email"),
		status: repairCompanyStatus("status").notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("repair_companies_water_purveyor_id_idx").on(table.waterPurveyorId),
		// One email address per purveyor, compared trimmed and lowercased. Partial:
		// email is optional, and any number of companies may have none. Added in
		// 0011; the procedures turn a violation into an inline Email error.
		uniqueIndex("repair_companies_water_purveyor_id_email_key")
			.on(table.waterPurveyorId, sql`lower(btrim(${table.email}))`)
			.where(sql`${table.email} is not null`),
	],
).enableRLS();
