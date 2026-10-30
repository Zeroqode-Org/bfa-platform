import { index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { certifiers } from "./certifiers";
import { authorizationStatus, certifierType } from "./enums";
import { waterPurveyors } from "./water-purveyors";

// Drives the certifier's WP selector.
export const wpCertifierAuthorizations = pgTable(
	"wp_certifier_authorizations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		certifierId: uuid("certifier_id")
			.notNull()
			.references(() => certifiers.id),
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		authorizationStatus: authorizationStatus("authorization_status")
			.notNull()
			.default("pending"),
		// Internal (the purveyor's own staff) or external (a private tester), as
		// the purveyor chose when inviting them — per purveyor, which is why it is
		// here and not on `certifiers`. Rows from before the choice existed are
		// external, the common case; the purveyor can move them.
		certifierType: certifierType("certifier_type")
			.notNull()
			.default("external"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("wp_certifier_authorizations_water_purveyor_id_idx").on(
			table.waterPurveyorId,
		),
		unique("wp_certifier_authorizations_certifier_id_water_purveyor_id_key").on(
			table.certifierId,
			table.waterPurveyorId,
		),
	],
).enableRLS();
