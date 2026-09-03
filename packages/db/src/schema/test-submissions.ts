import {
	type AnyPgColumn,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { bfaAssets } from "./bfa-assets";
import { certifiers } from "./certifiers";
import {
	bfaType,
	signatureMethod,
	submissionStatus,
	testResult,
} from "./enums";
import { profiles } from "./profiles";
import { waterPurveyors } from "./water-purveyors";

// The most access-sensitive table. Draft versus submitted state decides who
// may write — certifiers only their own drafts, WPs any submitted row.
export const testSubmissions = pgTable(
	"test_submissions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// nullable to support the no-BIN flow
		bfaAssetId: uuid("bfa_asset_id").references(() => bfaAssets.id),
		certifierId: uuid("certifier_id")
			.notNull()
			.references(() => certifiers.id),
		// denormalized from the WP selector at submit time, for simple RLS filtering
		waterPurveyorId: uuid("water_purveyor_id")
			.notNull()
			.references(() => waterPurveyors.id),
		status: submissionStatus("status").notNull().default("draft"),
		bfaType: bfaType("bfa_type").notNull(),
		// per-type field values; jsonb because the field set varies by type
		wizardData: jsonb("wizard_data").notNull(),
		// what the certifier typed when no BIN resolved
		submittedBinText: text("submitted_bin_text"),
		testDate: date("test_date"),
		testResult: testResult("test_result"),
		currentStep: integer("current_step"),
		// which prefilled values the certifier overwrote
		overriddenFields: jsonb("overridden_fields"),
		signatureMethod: signatureMethod("signature_method"),
		signatureData: text("signature_data"),
		// set when a certifier re-runs the wizard for the same BIN
		supersededBySubmissionId: uuid("superseded_by_submission_id").references(
			(): AnyPgColumn => testSubmissions.id,
		),
		// audit trail for WP corrections
		editedByWpProfileId: uuid("edited_by_wp_profile_id").references(
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
		index("test_submissions_water_purveyor_id_idx").on(table.waterPurveyorId),
		// the certifier dashboard's two queries
		index("test_submissions_certifier_id_status_idx").on(
			table.certifierId,
			table.status,
		),
	],
).enableRLS();
