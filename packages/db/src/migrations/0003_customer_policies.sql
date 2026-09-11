-- ---------------------------------------------------------------------------
-- customers
--
-- Row policies for the WP customer screen. RLS was enabled on the table in
-- 0000; until now it had no policies, which meant nothing reaching it through
-- PostgREST could see a row. These open exactly the WP-scoped paths the
-- dashboard needs and nothing wider.
--
-- Caller resolution goes through the two SECURITY DEFINER helpers introduced in
-- 0001 (`private.current_global_role()` / `private.current_wp_id()`), so a
-- blocked profile resolves to NULL here as it does everywhere else and keeps no
-- access at all.
--
-- Super-Admin: read, insert and update across every tenant. All three WP roles
-- read, insert and update rows whose `water_purveyor_id` matches their own —
-- inviting, creating and suspending a customer is clerk work, not an Admin-only
-- action.
--
-- No DELETE for anybody, Super-Admin included, and deliberately so. A customer
-- is referenced by `bfa_assets.current_customer_id`, by `customer_assignments`
-- occupancy history and by `scheduled_jobs`; removing one would take past
-- occupancy with it. Suspension is the reversible switch that exists instead.
--
-- The Super-Admin policy below reads `FOR ALL` and still cannot delete: the
-- GRANT above is what withholds DELETE from `authenticated`, and no policy can
-- hand back a privilege that was never granted. Postgres policies take one
-- command or all of them, so `FOR ALL` describes the policy's own scope; the
-- effective access is the intersection of that and the grant. Anything that
-- wants to change it has to change the grant, in a migration of its own.
--
-- The certifier read path described in the build plan — customers reachable
-- through `bfa_assets.current_customer_id` for an authorized purveyor, for
-- wizard prefill — is not here. It belongs with the wizard, and granting it now
-- would open a table to a role that has no screen for it yet.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public.customers TO authenticated;--> statement-breakpoint

CREATE POLICY "customers_all_super_admin" ON public.customers
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "customers_select_own_wp" ON public.customers
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

CREATE POLICY "customers_insert_own_wp" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

-- Both halves are needed and they are not the same check. USING decides which
-- rows can be reached; WITH CHECK decides what they may be turned into. Without
-- the second, a WP could hand its own customer to another purveyor by writing a
-- different `water_purveyor_id` — a row that leaves the tenant it was read in.
CREATE POLICY "customers_update_own_wp" ON public.customers
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  )
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );
