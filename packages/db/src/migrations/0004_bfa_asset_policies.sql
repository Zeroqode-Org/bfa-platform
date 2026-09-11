-- ---------------------------------------------------------------------------
-- bfa_assets
--
-- Row policies for the WP BFA-assets screen. RLS was enabled on the table in
-- 0000; until now it had no policies, so nothing reaching it through PostgREST
-- could see a row. These open exactly the WP-scoped paths the dashboard needs.
--
-- Caller resolution goes through the two SECURITY DEFINER helpers from 0001
-- (`private.current_global_role()` / `private.current_wp_id()`), so a blocked
-- profile resolves to NULL here as it does everywhere else and keeps no access.
--
-- Super-Admin: read, insert and update across every tenant. All three WP roles
-- read, insert and update rows whose `water_purveyor_id` matches their own —
-- registering an asset and correcting its details is clerk work, not an
-- Admin-only action.
--
-- The grants are column lists rather than a bare table grant, the same way
-- `profiles` withholds everything but `full_name` in 0001. Two columns are
-- deliberately missing:
--
--   * `asset_status` — recomputed by the scheduler from `annual_test_date`, and
--     never a value a person picks. A row policy cannot allow one column and
--     refuse another; a column grant can. The scheduler runs through the
--     privileged connection and is unaffected.
--   * `water_purveyor_id` on UPDATE — an asset never changes tenant, so the
--     privilege is simply not handed over. The WITH CHECK below says the same
--     thing a second time, deliberately: if a later migration widens the grant,
--     the policy is what still refuses.
--
-- No DELETE for anybody, Super-Admin included. An asset is referenced by
-- `customer_assignments` occupancy history, by `test_submissions` and by
-- `scheduled_jobs`; removing one would take that history with it. Nothing in
-- the product deletes an asset — a decommissioned one keeps its record.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.bfa_assets TO authenticated;--> statement-breakpoint

GRANT INSERT (
  water_purveyor_id, bin, current_customer_id, bfa_type, make, model,
  serial_number, size, service_address, assembly_location, annual_test_date
) ON public.bfa_assets TO authenticated;--> statement-breakpoint

GRANT UPDATE (
  bin, current_customer_id, bfa_type, make, model, serial_number, size,
  service_address, assembly_location, annual_test_date
) ON public.bfa_assets TO authenticated;--> statement-breakpoint

CREATE POLICY "bfa_assets_all_super_admin" ON public.bfa_assets
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "bfa_assets_select_own_wp" ON public.bfa_assets
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

CREATE POLICY "bfa_assets_insert_own_wp" ON public.bfa_assets
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

-- Both halves are needed and they are not the same check. USING decides which
-- rows can be reached; WITH CHECK decides what they may be turned into.
CREATE POLICY "bfa_assets_update_own_wp" ON public.bfa_assets
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  )
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- customer_assignments
--
-- Occupancy history. The table carries no `water_purveyor_id` of its own, so
-- tenancy is read through the asset the row points at: you may see an
-- assignment exactly when you may see its asset. That subquery is subject to
-- `bfa_assets`' own policies above, which is what makes the coupling hold
-- rather than merely look right — a caller who cannot select the asset cannot
-- satisfy the EXISTS either.
--
-- Insert additionally checks the *customer*'s tenant. An assignment joining one
-- purveyor's asset to another's customer is the one cross-tenant row this table
-- could hold; `assignCustomer` already refuses it at the procedure layer, and
-- this is the same refusal again for anything arriving another way.
--
-- UPDATE exists for one column's sake: closing the current assignment by
-- setting `end_date`. Nothing rewrites which asset or customer a historical row
-- names, so those columns stay out of the grant — a past occupancy that can be
-- edited into a different one is not history.
--
-- No DELETE: an assignment that can be removed is an occupancy record that can
-- be made never to have happened.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.customer_assignments TO authenticated;--> statement-breakpoint
GRANT INSERT (bfa_asset_id, customer_id, start_date, end_date) ON public.customer_assignments TO authenticated;--> statement-breakpoint
GRANT UPDATE (end_date) ON public.customer_assignments TO authenticated;--> statement-breakpoint

CREATE POLICY "customer_assignments_all_super_admin" ON public.customer_assignments
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "customer_assignments_select_own_wp" ON public.customer_assignments
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND EXISTS (
      SELECT 1 FROM public.bfa_assets a
      WHERE a.id = customer_assignments.bfa_asset_id
        AND a.water_purveyor_id = (SELECT private.current_wp_id())
    )
  );--> statement-breakpoint

CREATE POLICY "customer_assignments_insert_own_wp" ON public.customer_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND EXISTS (
      SELECT 1 FROM public.bfa_assets a
      WHERE a.id = customer_assignments.bfa_asset_id
        AND a.water_purveyor_id = (SELECT private.current_wp_id())
    )
    AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_assignments.customer_id
        AND c.water_purveyor_id = (SELECT private.current_wp_id())
    )
  );--> statement-breakpoint

CREATE POLICY "customer_assignments_update_own_wp" ON public.customer_assignments
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND EXISTS (
      SELECT 1 FROM public.bfa_assets a
      WHERE a.id = customer_assignments.bfa_asset_id
        AND a.water_purveyor_id = (SELECT private.current_wp_id())
    )
  )
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND EXISTS (
      SELECT 1 FROM public.bfa_assets a
      WHERE a.id = customer_assignments.bfa_asset_id
        AND a.water_purveyor_id = (SELECT private.current_wp_id())
    )
  );
