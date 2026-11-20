import { sql } from "drizzle-orm";
import {
	date,
	index,
	integer,
	pgTable,
	text,
	timestamp,
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
		// Deprecated (0025): the account number moved to `bfa_assets`, one per
		// BIN. Nothing reads or writes this column; a later migration copies any
		// value left here onto the assets and drops it.
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
		// The email lookup — not unique. Several of a purveyor's customers may
		// share one address (0024, replacing 0011's unique index); the wizard
		// and register-from-test flows still find customers by it, compared the
		// way the application stores it (trimmed, lowercased).
		index("customers_water_purveyor_id_email_idx").on(
			table.waterPurveyorId,
			sql`lower(btrim(${table.email}))`,
		),
	],
).enableRLS();
