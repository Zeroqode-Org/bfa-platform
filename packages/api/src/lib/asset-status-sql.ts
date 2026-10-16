import { bfaAssets } from "@bfa-platform/db/schema";
import { type SQL, sql } from "drizzle-orm";

import { honoluluToday } from "./honolulu-dates";
import { REMINDER_LEAD_MONTHS } from "./notice-schedule";

type AssetStatus = "active" | "due_soon" | "past_due";

/**
 * An asset's status as of today in Hawaii, worked out from `annual_test_date`
 * in SQL — `assetStatusFor` restated, in the same order and with the same
 * boundaries: the due date itself is `due_soon`, the day after is `past_due`,
 * and the `due_soon` window opens on the reminder day.
 *
 * Every screen that shows or filters by status reads this rather than the
 * stored `asset_status` column (WP/Admin feedback). The column is written only
 * by the scheduler's tick, so a deployment where the tick runs rarely — or not
 * at all — showed assets months overdue as on time: a Home "Past due" of 0 and
 * an empty Past due filter. Deriving it at read time makes the screens right
 * whatever the scheduler is doing. The tick still keeps the column in step,
 * through the same expression, for anything reading the table directly.
 *
 * The one zone-dependent value — which day "now" is — is computed in Hawaii
 * and bound as a `date`. Postgres' `current_date` would name the day in the
 * server's zone, which on Vercel is UTC: for the last fourteen hours of every
 * Hawaii day, an assembly due today would already read as `past_due`.
 *
 * `make_interval(months => …)` rather than a literal interval, so the lead
 * time has one definition — {@link REMINDER_LEAD_MONTHS}. Subtracting whole
 * months from a `date` clamps to the end of the month in Postgres exactly as
 * `addCalendarMonths` does, so 30 April less two months is 28 February in both.
 */
export function effectiveAssetStatus(now: Date = new Date()): SQL<AssetStatus> {
	const today = honoluluToday(now);

	return sql<AssetStatus>`(case
		when ${bfaAssets.annualTestDate} is null then 'active'
		when ${bfaAssets.annualTestDate} < ${today}::date then 'past_due'
		when ${today}::date >= (${bfaAssets.annualTestDate} - make_interval(months => ${REMINDER_LEAD_MONTHS}))::date then 'due_soon'
		else 'active'
	end)::asset_status`;
}

/** Whether an asset is past due as of today in Hawaii — the filter form. */
export function isPastDue(now: Date = new Date()): SQL {
	return sql`${bfaAssets.annualTestDate} < ${honoluluToday(now)}::date`;
}
