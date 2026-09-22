-- ---------------------------------------------------------------------------
-- The privilege baseline, stated in migrations for the first time
--
-- WHAT WAS FOUND. Every RLS suite asserts that a write without a migration
-- grant fails with a *privilege* error ("permission denied"), and every
-- feature migration hands out narrow grants on the assumption that the API
-- roles start with nothing. Neither assumption was ever expressed in a
-- migration. They held on the development database only because that
-- project's default ACL for tables created by `postgres` in `public` had been
-- modified outside migration history: the four DML privileges were removed
-- from Supabase's classic `GRANT ALL ... TO anon, authenticated,
-- service_role` default, leaving a remainder of TRUNCATE, REFERENCES,
-- TRIGGER (and MAINTAIN on PG17) on every table — visible in
-- `pg_default_acl` as `Dxtm` and in `role_table_grants` on all thirteen
-- tables. On a genuinely fresh project with the classic defaults, running
-- 0000–0016 would instead leave `authenticated` (and `anon`) holding full
-- DML on every table: rows would still be guarded by RLS, but the grant
-- boundary the suites assert — and the defense-in-depth the migrations'
-- comments describe — would silently not exist. The remainder is not
-- harmless either: TRUNCATE is not subject to row policies, and `anon` held
-- it on every table of an invite-only product.
--
-- (For the record, the *suspected* drift that triggered this audit — the
-- certifier read/write policies on `test_submissions` — turned out not to be
-- drift at all: they are 0012/0013, which had been applied to the dev
-- database from their feature branch before it merged. The journal and the
-- database agree row-for-row; the only unexpressed state was this baseline.)
--
-- WHAT THIS MIGRATION DOES. Makes the intended baseline reproducible from
-- history alone, on any starting state:
--
-- 1. Future tables created by `postgres` in `public` start with no
--    privileges for the API roles. Each feature grants what it needs, which
--    is the style every migration since 0001 already follows.
-- 2. Every existing app table is stripped back to nothing for `anon`,
--    `authenticated` and `service_role`, and then the exact surface the
--    feature migrations granted is restated. REVOKE ALL at table level also
--    removes column-level grants (verified against PG17), so the column
--    lists from 0001/0004/0005/0006+0007/0008+0012/0010 are restated here
--    verbatim — the same "third statement of the truth" cost a partial
--    index pays when it is used as an ON CONFLICT target, and the pinning
--    suite in `packages/db/src/privilege-baseline.test.ts` is what keeps
--    the copies honest.
--
-- `anon` ends with nothing anywhere: this is an invite-only product with no
-- anonymous surface. `service_role` ends with nothing anywhere: the
-- application's own privileged access is the `postgres` Drizzle connection
-- (which owns the tables and is untouched), the Supabase service key is used
-- only for the auth admin API, and a future feature that reads app tables
-- through PostgREST as `service_role` should say so with a grant of its own.
-- Sequences and functions need no sweep: the project's default ACLs already
-- give the API roles nothing there, `uuid` keys mean no sequences exist, and
-- the `private.*` helpers manage their own EXECUTE grants.
--
-- Idempotent by construction: revoking a privilege a role does not hold is a
-- no-op, so this runs identically on the dev database (removing the `Dxtm`
-- remainder), on a classic-defaults clone (removing full DML), and on a
-- database that is already at the baseline.
-- ---------------------------------------------------------------------------

-- 1. Future tables start clean for the API roles.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;--> statement-breakpoint

-- 2. Existing tables: strip, then restate the granted surface.
REVOKE ALL ON public.bfa_assets FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.certifiers FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.customer_assignments FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.customers FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.invitations FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.notice_templates FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.profiles FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.repair_companies FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.scheduled_jobs FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.test_submissions FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.water_purveyors FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.wp_certifier_authorizations FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON public.wp_feature_flags FROM anon, authenticated, service_role;--> statement-breakpoint

-- profiles — 0001.
GRANT SELECT ON public.profiles TO authenticated;--> statement-breakpoint
GRANT UPDATE (full_name) ON public.profiles TO authenticated;--> statement-breakpoint

-- invitations — 0001.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO authenticated;--> statement-breakpoint

-- customers — 0003.
GRANT SELECT, INSERT, UPDATE ON public.customers TO authenticated;--> statement-breakpoint

-- bfa_assets — 0004.
GRANT SELECT ON public.bfa_assets TO authenticated;--> statement-breakpoint
GRANT INSERT (
  water_purveyor_id, bin, current_customer_id, bfa_type, make, model,
  serial_number, size, service_address, assembly_location, annual_test_date
) ON public.bfa_assets TO authenticated;--> statement-breakpoint
GRANT UPDATE (
  bin, current_customer_id, bfa_type, make, model, serial_number, size,
  service_address, assembly_location, annual_test_date
) ON public.bfa_assets TO authenticated;--> statement-breakpoint

-- customer_assignments — 0004.
GRANT SELECT ON public.customer_assignments TO authenticated;--> statement-breakpoint
GRANT INSERT (bfa_asset_id, customer_id, start_date, end_date) ON public.customer_assignments TO authenticated;--> statement-breakpoint
GRANT UPDATE (end_date) ON public.customer_assignments TO authenticated;--> statement-breakpoint

-- repair_companies — 0005.
GRANT SELECT ON public.repair_companies TO authenticated;--> statement-breakpoint
GRANT INSERT (
  water_purveyor_id, company_name, phone, email, status
) ON public.repair_companies TO authenticated;--> statement-breakpoint
GRANT UPDATE (
  company_name, phone, email, status
) ON public.repair_companies TO authenticated;--> statement-breakpoint

-- certifiers — 0006, widened by 0007 (the union is the effective grant; the
-- per-role narrowing lives in the trigger 0007 installed, not here).
GRANT SELECT ON public.certifiers TO authenticated;--> statement-breakpoint
GRANT UPDATE (
  status, company, id_number, license_expiration_date
) ON public.certifiers TO authenticated;--> statement-breakpoint

-- test_submissions — 0008, widened by 0012 (same union rule; the per-role
-- narrowing is 0012's trigger).
GRANT SELECT ON public.test_submissions TO authenticated;--> statement-breakpoint
GRANT DELETE ON public.test_submissions TO authenticated;--> statement-breakpoint
GRANT UPDATE (
  bfa_asset_id, bfa_type, wizard_data, submitted_bin_text, test_date,
  test_result, signature_method, signature_data, current_step, overridden_fields
) ON public.test_submissions TO authenticated;--> statement-breakpoint

-- notice_templates — 0010.
GRANT SELECT ON public.notice_templates TO authenticated;--> statement-breakpoint
GRANT INSERT (
  water_purveyor_id, notice_type, subject, body
) ON public.notice_templates TO authenticated;--> statement-breakpoint
GRANT UPDATE (
  subject, body
) ON public.notice_templates TO authenticated;--> statement-breakpoint

-- wp_certifier_authorizations — 0013.
GRANT SELECT ON public.wp_certifier_authorizations TO authenticated;--> statement-breakpoint

-- scheduled_jobs — 0014.
GRANT SELECT ON public.scheduled_jobs TO authenticated;--> statement-breakpoint

-- water_purveyors and wp_feature_flags deliberately end bare: no migration
-- has ever granted the API roles anything on either, and both are read by the
-- application only through the privileged connection.
