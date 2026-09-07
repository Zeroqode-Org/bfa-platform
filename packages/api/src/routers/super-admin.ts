import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	testSubmissions,
	waterPurveyors,
	wpCertifierAuthorizations,
} from "@bfa-platform/db/schema";
import { asc, sql } from "drizzle-orm";

import { router, superAdminProcedure } from "../index";

/**
 * Per-WP counts as correlated scalar subqueries — one round trip. Joining the
 * three one-to-many tables and grouping instead would multiply their rows
 * against each other and inflate every count.
 */
const assetCount = sql<number>`(
	select count(*) from ${bfaAssets}
	where ${bfaAssets.waterPurveyorId} = ${waterPurveyors.id}
)`.mapWith(Number);

const activeCertifierCount = sql<number>`(
	select count(*) from ${wpCertifierAuthorizations}
	where ${wpCertifierAuthorizations.waterPurveyorId} = ${waterPurveyors.id}
	  and ${wpCertifierAuthorizations.authorizationStatus} = 'active'
)`.mapWith(Number);

const submittedTestCount = sql<number>`(
	select count(*) from ${testSubmissions}
	where ${testSubmissions.waterPurveyorId} = ${waterPurveyors.id}
	  and ${testSubmissions.status} = 'submitted'
)`.mapWith(Number);

export const superAdminRouter = router({
	/**
	 * Every water purveyor on the platform with its asset, active-certifier and
	 * submitted-test counts. Reads through the privileged Drizzle connection, so
	 * `superAdminProcedure` is the authorization boundary, not a row policy.
	 */
	listWaterPurveyors: superAdminProcedure.query(async () => {
		return await db
			.select({
				id: waterPurveyors.id,
				companyName: waterPurveyors.companyName,
				pwsid: waterPurveyors.pwsid,
				status: waterPurveyors.status,
				createdAt: waterPurveyors.createdAt,
				assets: assetCount,
				certifiers: activeCertifierCount,
				submissions: submittedTestCount,
			})
			.from(waterPurveyors)
			.orderBy(asc(waterPurveyors.companyName));
	}),
});
