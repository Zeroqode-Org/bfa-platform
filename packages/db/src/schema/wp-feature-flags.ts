import {
	boolean,
	index,
	pgTable,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { featureFlag } from "./enums";
import { profiles } from "./profiles";
import { waterPurveyors } from "./water-purveyors";

// Which optional features are switched on for a given WP. Super-Admin
// controls these; a WP cannot toggle its own. A missing row means off —
// optional features default to disabled and must be switched on
// deliberately, so a new WP never starts sending automated mail by surprise.
export const wpFeatureFlags = pgTable(
	"wp_feature_flags",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		feature: featureFlag("feature").notNull(),
		isEnabled: boolean("is_enabled").notNull().default(false),
		updatedByProfileId: uuid("updated_by_profile_id").references(
			() => profiles.id,
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("wp_feature_flags_water_purveyor_id_idx").on(table.waterPurveyorId),
		unique("wp_feature_flags_water_purveyor_id_feature_key").on(
			table.waterPurveyorId,
			table.feature,
		),
	],
).enableRLS();
