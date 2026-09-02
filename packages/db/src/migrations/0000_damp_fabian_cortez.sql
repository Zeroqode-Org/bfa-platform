CREATE TYPE "public"."active_blocked" AS ENUM('active', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('active', 'due_soon', 'past_due');--> statement-breakpoint
CREATE TYPE "public"."authorization_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."bfa_type" AS ENUM('RP', 'RPDA', 'RPDA-2', 'DC', 'DCDA', 'DCDA-2', 'PVB', 'SVB');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."feature_flag" AS ENUM('automated_notices', 'ag_renewal_notice');--> statement-breakpoint
CREATE TYPE "public"."global_role" AS ENUM('super_admin', 'wp_admin', 'wp_sub_admin', 'wp_employee', 'certifier');--> statement-breakpoint
CREATE TYPE "public"."invitation_role" AS ENUM('wp_admin', 'wp_sub_admin', 'wp_employee', 'certifier');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'redeemed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('reminder', 'late_notice_1', 'late_notice_2', 'final_notice', 'ag_renewal', 'fail_list_check');--> statement-breakpoint
CREATE TYPE "public"."notice_type" AS ENUM('reminder', 'late_notice_1', 'late_notice_2', 'final_notice');--> statement-breakpoint
CREATE TYPE "public"."rate_category" AS ENUM('standard', 'agricultural');--> statement-breakpoint
CREATE TYPE "public"."repair_company_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."signature_method" AS ENUM('signed', 'owner_absent');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."test_result" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TABLE "bfa_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"bin" text NOT NULL,
	"current_customer_id" uuid,
	"bfa_type" "bfa_type" NOT NULL,
	"make" text,
	"model" text,
	"serial_number" text,
	"size" text,
	"service_address" text NOT NULL,
	"assembly_location" text,
	"annual_test_date" date,
	"asset_status" "asset_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bfa_assets_water_purveyor_id_bin_key" UNIQUE("water_purveyor_id","bin")
);
--> statement-breakpoint
ALTER TABLE "bfa_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "certifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"company" text,
	"id_number" text,
	"license_expiration_date" date,
	"status" "active_blocked" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certifiers_profile_id_unique" UNIQUE("profile_id")
);
--> statement-breakpoint
ALTER TABLE "certifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bfa_asset_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"account_number" text,
	"name" text NOT NULL,
	"address" text,
	"email" text NOT NULL,
	"rate_category" "rate_category" DEFAULT 'standard' NOT NULL,
	"ag_renewal_date" date,
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "water_purveyors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"address" text,
	"pwsid" text,
	"subdomain" text,
	"status" "active_blocked" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "water_purveyors_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
ALTER TABLE "water_purveyors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"water_purveyor_id" uuid,
	"full_name" text,
	"global_role" "global_role" NOT NULL,
	"status" "active_blocked" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wp_certifier_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certifier_id" uuid NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"authorization_status" "authorization_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wp_certifier_authorizations_certifier_id_water_purveyor_id_key" UNIQUE("certifier_id","water_purveyor_id")
);
--> statement-breakpoint
ALTER TABLE "wp_certifier_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "repair_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"phone" text,
	"email" text,
	"status" "repair_company_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repair_companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notice_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"notice_type" "notice_type" NOT NULL,
	"subject" text,
	"body" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_templates_water_purveyor_id_notice_type_key" UNIQUE("water_purveyor_id","notice_type")
);
--> statement-breakpoint
ALTER TABLE "notice_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wp_feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"feature" "feature_flag" NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"updated_by_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wp_feature_flags_water_purveyor_id_feature_key" UNIQUE("water_purveyor_id","feature")
);
--> statement-breakpoint
ALTER TABLE "wp_feature_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bfa_asset_id" uuid,
	"certifier_id" uuid NOT NULL,
	"water_purveyor_id" uuid NOT NULL,
	"status" "submission_status" DEFAULT 'draft' NOT NULL,
	"bfa_type" "bfa_type" NOT NULL,
	"wizard_data" jsonb NOT NULL,
	"submitted_bin_text" text,
	"test_date" date,
	"test_result" "test_result",
	"current_step" integer,
	"overridden_fields" jsonb,
	"signature_method" "signature_method",
	"signature_data" text,
	"superseded_by_submission_id" uuid,
	"edited_by_wp_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "invitation_role" NOT NULL,
	"token" text NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"associated_wp_id" uuid,
	"invited_by_profile_id" uuid,
	"is_redeemed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" "job_type" NOT NULL,
	"bfa_asset_id" uuid,
	"customer_id" uuid,
	"water_purveyor_id" uuid NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bfa_assets" ADD CONSTRAINT "bfa_assets_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bfa_assets" ADD CONSTRAINT "bfa_assets_current_customer_id_customers_id_fk" FOREIGN KEY ("current_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifiers" ADD CONSTRAINT "certifiers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_bfa_asset_id_bfa_assets_id_fk" FOREIGN KEY ("bfa_asset_id") REFERENCES "public"."bfa_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_certifier_authorizations" ADD CONSTRAINT "wp_certifier_authorizations_certifier_id_certifiers_id_fk" FOREIGN KEY ("certifier_id") REFERENCES "public"."certifiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_certifier_authorizations" ADD CONSTRAINT "wp_certifier_authorizations_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_companies" ADD CONSTRAINT "repair_companies_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_templates" ADD CONSTRAINT "notice_templates_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_feature_flags" ADD CONSTRAINT "wp_feature_flags_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_feature_flags" ADD CONSTRAINT "wp_feature_flags_updated_by_profile_id_profiles_id_fk" FOREIGN KEY ("updated_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_bfa_asset_id_bfa_assets_id_fk" FOREIGN KEY ("bfa_asset_id") REFERENCES "public"."bfa_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_certifier_id_certifiers_id_fk" FOREIGN KEY ("certifier_id") REFERENCES "public"."certifiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_superseded_by_submission_id_test_submissions_id_fk" FOREIGN KEY ("superseded_by_submission_id") REFERENCES "public"."test_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_edited_by_wp_profile_id_profiles_id_fk" FOREIGN KEY ("edited_by_wp_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_associated_wp_id_water_purveyors_id_fk" FOREIGN KEY ("associated_wp_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_profile_id_profiles_id_fk" FOREIGN KEY ("invited_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_bfa_asset_id_bfa_assets_id_fk" FOREIGN KEY ("bfa_asset_id") REFERENCES "public"."bfa_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_water_purveyor_id_water_purveyors_id_fk" FOREIGN KEY ("water_purveyor_id") REFERENCES "public"."water_purveyors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bfa_assets_water_purveyor_id_idx" ON "bfa_assets" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "customer_assignments_asset_end_date_idx" ON "customer_assignments" USING btree ("bfa_asset_id","end_date");--> statement-breakpoint
CREATE INDEX "customers_water_purveyor_id_idx" ON "customers" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "profiles_water_purveyor_id_idx" ON "profiles" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "wp_certifier_authorizations_water_purveyor_id_idx" ON "wp_certifier_authorizations" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "repair_companies_water_purveyor_id_idx" ON "repair_companies" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "notice_templates_water_purveyor_id_idx" ON "notice_templates" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "wp_feature_flags_water_purveyor_id_idx" ON "wp_feature_flags" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "test_submissions_water_purveyor_id_idx" ON "test_submissions" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "test_submissions_certifier_id_status_idx" ON "test_submissions" USING btree ("certifier_id","status");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_water_purveyor_id_idx" ON "scheduled_jobs" USING btree ("water_purveyor_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_status_run_at_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "water_purveyors" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "profiles" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "certifiers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "customers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "bfa_assets" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "repair_companies" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "notice_templates" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "wp_feature_flags" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "test_submissions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "scheduled_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();