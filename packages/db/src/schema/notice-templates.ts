import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { noticeType } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// One row per WP per notice type. A missing row means the WP has not
// customized that notice — fall back to the platform default text rather
// than backfilling rows on WP creation.
//
// is_enabled is stored but stays unwired for now: the client's toggle
// requirement operates a level up — automated notices are a paid add-on the
// Super-Admin switches on per WP via wp_feature_flags, not a per-notice-type
// switch the WP controls. Don't build the is_enabled toggle in the UI until
// what disabling a middle step means for the escalation chain is answered.
export const noticeTemplates = pgTable(
	"notice_templates",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		noticeType: noticeType("notice_type").notNull(),
		subject: text("subject"),
		body: text("body"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("notice_templates_water_purveyor_id_idx").on(table.waterPurveyorId),
		unique("notice_templates_water_purveyor_id_notice_type_key").on(
			table.waterPurveyorId,
			table.noticeType,
		),
	],
).enableRLS();
