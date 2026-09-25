import { sql } from "drizzle-orm";
import {
	date,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

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
		// The optimistic lock behind the edit form (0020). Every real change —
		// a WP save, or the AG renewal notice moving `ag_renewal_date` on a year
		// — bumps it in the same conditional write, so a form opened before that
		// change is refused rather than allowed to put the old record back.
		revision: integer("revision").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("customers_water_purveyor_id_idx").on(table.waterPurveyorId),
		// One email address per purveyor, compared the way the application stores
		// it (trimmed, lowercased) so no second spelling can slip past. Added in
		// 0011; the procedures turn a violation into an inline Email error.
		uniqueIndex("customers_water_purveyor_id_email_key").on(
			table.waterPurveyorId,
			sql`lower(btrim(${table.email}))`,
		),
	],
).enableRLS();
