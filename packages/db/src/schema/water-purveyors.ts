import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { activeBlocked } from "./enums";

export const waterPurveyors = pgTable("water_purveyors", {
	id: uuid("id").defaultRandom().primaryKey(),
	companyName: text("company_name").notNull(),
	address: text("address"),
	pwsid: text("pwsid"),
	subdomain: text("subdomain").unique(),
	status: activeBlocked("status").notNull().default("active"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
}).enableRLS();
