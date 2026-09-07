import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	testSubmissions,
	waterPurveyors,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { asc, count, eq } from "drizzle-orm";

import { router, superAdminProcedure } from "../index";

/** Rows of `{ wpId, value }` into a lookup, so the merge below stays O(n). */
function toCountMap(rows: { wpId: string; value: number }[]) {
	return new Map(rows.map((row) => [row.wpId, row.value]));
}

export const superAdminRouter = router({
	/**
	 * Every water purveyor on the platform with its asset, active-certifier and
	 * submitted-test counts.
	 *
	 * Four queries — the purveyors plus one grouped aggregate per counted table —
	 * run in parallel and merged by id. That count is fixed regardless of how
	 * many purveyors come back, so there is no N+1. One query with three joins
	 * would multiply the three one-to-many tables against each other and inflate
	 * every count; correlated subqueries avoid that but collapse into a single
	 * `count` column on the driver's row object, which silently reads back as
	 * zero.
	 *
	 * Reads through the privileged Drizzle connection, so `superAdminProcedure`
	 * is the authorization boundary, not a row policy.
	 */
	listWaterPurveyors: superAdminProcedure.query(async () => {
		const [purveyors, assetRows, certifierRows, submissionRows] =
			await Promise.all([
				db
					.select({
						id: waterPurveyors.id,
						companyName: waterPurveyors.companyName,
						pwsid: waterPurveyors.pwsid,
						status: waterPurveyors.status,
						createdAt: waterPurveyors.createdAt,
					})
					.from(waterPurveyors)
					.orderBy(asc(waterPurveyors.companyName)),

				db
					.select({ wpId: bfaAssets.waterPurveyorId, value: count() })
					.from(bfaAssets)
					.groupBy(bfaAssets.waterPurveyorId),

				db
					.select({
						wpId: wpCertifierAuthorizations.waterPurveyorId,
						value: count(),
					})
					.from(wpCertifierAuthorizations)
					.where(eq(wpCertifierAuthorizations.authorizationStatus, "active"))
					.groupBy(wpCertifierAuthorizations.waterPurveyorId),

				db
					.select({ wpId: testSubmissions.waterPurveyorId, value: count() })
					.from(testSubmissions)
					.where(eq(testSubmissions.status, "submitted"))
					.groupBy(testSubmissions.waterPurveyorId),
			]);

		const assets = toCountMap(assetRows);
		const certifiers = toCountMap(certifierRows);
		const submissions = toCountMap(submissionRows);

		return purveyors.map((purveyor) => ({
			...purveyor,
			// A purveyor with nothing counted has no row in its aggregate.
			assets: assets.get(purveyor.id) ?? 0,
			certifiers: certifiers.get(purveyor.id) ?? 0,
			submissions: submissions.get(purveyor.id) ?? 0,
		}));
	}),
});
