import { pgEnum } from "drizzle-orm/pg-core";

export const globalRole = pgEnum("global_role", [
  "super_admin",
  "wp_admin",
  "wp_sub_admin",
  "wp_employee",
  "certifier",
]);

export const activeBlocked = pgEnum("active_blocked", ["active", "blocked"]);

export const bfaType = pgEnum("bfa_type", [
  "RP",
  "RPDA",
  "RPDA-2",
  "DC",
  "DCDA",
  "DCDA-2",
  "PVB",
  "SVB",
]);

export const assetStatus = pgEnum("asset_status", ["active", "due_soon", "past_due"]);

export const rateCategory = pgEnum("rate_category", ["standard", "agricultural"]);

export const customerStatus = pgEnum("customer_status", ["active", "suspended"]);

export const authorizationStatus = pgEnum("authorization_status", [
  "pending",
  "active",
  "revoked",
]);

export const repairCompanyStatus = pgEnum("repair_company_status", ["active", "inactive"]);

// Shared source list for notice_type and job_type — Postgres has no enum
// union/extension, so these stay two separate enums, but job_type's four
// notice-shaped values are spread from this one array rather than retyped.
export const noticeTypeValues = [
  "reminder",
  "late_notice_1",
  "late_notice_2",
  "final_notice",
] as const;

export const noticeType = pgEnum("notice_type", noticeTypeValues);

export const submissionStatus = pgEnum("submission_status", ["draft", "submitted"]);

export const testResult = pgEnum("test_result", ["pass", "fail"]);

export const signatureMethod = pgEnum("signature_method", ["signed", "owner_absent"]);

export const invitationRole = pgEnum("invitation_role", [
  "wp_admin",
  "wp_sub_admin",
  "wp_employee",
  "certifier",
]);

export const invitationStatus = pgEnum("invitation_status", [
  "pending",
  "redeemed",
  "expired",
]);

export const featureFlag = pgEnum("feature_flag", ["automated_notices", "ag_renewal_notice"]);

export const jobType = pgEnum("job_type", [
  ...noticeTypeValues,
  "ag_renewal",
  "fail_list_check",
]);

export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
