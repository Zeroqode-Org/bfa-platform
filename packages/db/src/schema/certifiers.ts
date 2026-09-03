import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { activeBlocked } from "./enums";
import { profiles } from "./profiles";

export const certifiers = pgTable("certifiers", {
	id: uuid("id").defaultRandom().primaryKey(),
	profileId: uuid("profile_id")
		.notNull()
		.unique()
		.references(() => profiles.id),
	company: text("company"),
	idNumber: text("id_number"),
	licenseExpirationDate: date("license_expiration_date"),
	// blocked prevents login
	status: activeBlocked("status").notNull().default("active"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
}).enableRLS();
