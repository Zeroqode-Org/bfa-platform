import { date, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { bfaAssets } from "./bfa-assets";
import { customers } from "./customers";

// Occupancy history. One asset can have several customers in sequence; one
// customer can hold several assets. bfa_assets.current_customer_id stays as
// the live pointer — this table preserves past occupancy when that pointer
// changes.
export const customerAssignments = pgTable(
	"customer_assignments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		bfaAssetId: uuid("bfa_asset_id")
			.notNull()
			.references(() => bfaAssets.id),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id),
		startDate: date("start_date").notNull(),
		// null means current
		endDate: date("end_date"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		// resolving the current occupant
		index("customer_assignments_asset_end_date_idx").on(
			table.bfaAssetId,
			table.endDate,
		),
	],
).enableRLS();
