import { sql } from "drizzle-orm";
import {
	date,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { assetStatus, bfaType } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// The permanent physical-valve record. annual_test_date drives the reminder
// engine. bin reassignment on an existing row is allowed (a WP may correct
// any data it owns) but must be logged at the procedure layer — every BIN
// change emits a structured JSON line with the old and new value.
export const bfaAssets = pgTable(
	"bfa_assets",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		bin: text("bin").notNull(),
		// live pointer; occupancy history lives in customer_assignments
		currentCustomerId: uuid("current_customer_id").references(
			() => customers.id,
		),
		bfaType: bfaType("bfa_type").notNull(),
		make: text("make"),
		model: text("model"),
		serialNumber: text("serial_number"),
		size: text("size"),
		serviceAddress: text("service_address").notNull(),
		assemblyLocation: text("assembly_location"),
		annualTestDate: date("annual_test_date"),
		// recomputed by the scheduler, never set directly by a user
		assetStatus: assetStatus("asset_status").notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("bfa_assets_water_purveyor_id_idx").on(table.waterPurveyorId),
		// doubles as the BIN lookup index
		unique("bfa_assets_water_purveyor_id_bin_key").on(
			table.waterPurveyorId,
			table.bin,
		),
		// The general-info broadcast's past-due audience: does this customer own
		// any assembly the scheduler has marked past_due? The two lookup columns
		// are in the index and the status is in the predicate, so it covers only
		// the delinquent slice rather than carrying a third column across every
		// asset row. Added in 0010 alongside the notice_templates policies.
		index("bfa_assets_wp_past_due_customer_idx")
			.on(table.waterPurveyorId, table.currentCustomerId)
			.where(sql`${table.assetStatus} = 'past_due'`),
	],
).enableRLS();
