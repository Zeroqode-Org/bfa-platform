/**
 * Recomputing `bfa_assets.asset_status` from `annual_test_date`.
 *
 * The column is scheduler-owned. No mutation accepts one — `assetColumns` in
 * `lib/asset-input.ts` has no status field and the asset form shows it
 * read-only — and this is the only thing that writes it. The screens no longer
 * read it: they derive the status from the date at read time through
 * `effectiveAssetStatus` (`lib/asset-status-sql.ts`), because a deployment
 * whose tick runs rarely left this column weeks stale. This keeps it in step,
 * through that same expression, for anything reading the table directly.
 *
 * One statement for the whole table rather than a job row per asset. The rule
 * is `assetStatusFor`'s, restated in SQL because pulling every asset into Node
 * to compare two strings would be a table scan with a round trip attached — and
 * the `WHERE` clause means the statement touches only the rows whose status is
 * actually wrong, so an ordinary day writes nothing, moves no `updated_at`, and
 * emits no log line.
 *
 * The one zone-dependent value — which day "now" is — is computed in Hawaii,
 * explicitly, and passed in as a `date`. Letting Postgres use `current_date`
 * would name the day in the *server's* zone, which on Vercel is UTC: for the
 * last fourteen hours of every Hawaii day, an assembly due today would already
 * be `past_due`.
 */

import { db } from "@bfa-platform/db";
import { sql } from "drizzle-orm";

import { effectiveAssetStatus } from "../lib/asset-status-sql";
import { honoluluToday } from "../lib/honolulu-dates";
import { logSchedulerEvent } from "./logging";

/**
 * Brings every asset's status into line with today in Hawaii. Returns how many
 * rows changed.
 *
 * The `CASE` is `assetStatusFor` in SQL, in the same order and with the same
 * boundaries: the due date itself is `due_soon`, not `past_due`, because that is
 * the last day the test can still be done — and it is why late notice 1 is due
 * the day after. The `due_soon` window opens on the reminder day, so a purveyor
 * seeing `due_soon` on a row can assume the customer has been written to.
 */
export async function recomputeAssetStatuses({
	now = new Date(),
}: {
	now?: Date;
} = {}): Promise<number> {
	const today = honoluluToday(now);

	// The same expression every screen reads the status through, so the column
	// this writes and the status those screens show cannot disagree.
	const computed = effectiveAssetStatus(now);

	const result = await db.execute(
		sql`update "bfa_assets"
			set "asset_status" = ${computed}
			where "asset_status" <> ${computed}`,
	);

	const changed = result.rowCount ?? 0;

	// Nothing to say on the ordinary day when every status is already right.
	if (changed > 0) {
		logSchedulerEvent("scheduler_asset_status_recomputed", {
			extra: { today, changed_count: changed },
		});
	}

	return changed;
}
