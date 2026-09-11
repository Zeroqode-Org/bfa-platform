-- ---------------------------------------------------------------------------
-- repair_companies
--
-- Row policies for the WP repair-companies screen. RLS was enabled on the table
-- in 0000; until now it had no policies, so nothing reaching it through
-- PostgREST could see a row. These open exactly the WP-scoped paths the
-- dashboard needs and nothing wider.
--
-- Caller resolution goes through the two SECURITY DEFINER helpers from 0001
-- (`private.current_global_role()` / `private.current_wp_id()`), so a blocked
-- profile resolves to NULL here as it does everywhere else and keeps no access.
--
-- Super-Admin: read, insert and update across every tenant. All three WP roles
-- read, insert and update rows whose `water_purveyor_id` matches their own —
-- keeping the approved-repairer list current is clerk work, not an Admin-only
-- action.
--
-- Certifier: nothing at all. A certifier records that an assembly failed; who a
-- purveyor recommends for the repair is the purveyor's own list, and it reaches
-- the customer through the failure notice rather than through the wizard.
--
-- The grants are column lists rather than a bare table grant, the same way
-- `bfa_assets` is written in 0004. `water_purveyor_id` is deliberately missing
-- from the UPDATE grant: a repair company never changes tenant, so the privilege
-- is simply not handed over. The WITH CHECK below says the same thing a second
-- time, deliberately — if a later migration widens the grant, the policy is what
-- still refuses.
--
-- No DELETE for anybody, Super-Admin included, and deliberately so. The failure
-- notice names the companies that were active when it was sent; deleting a row
-- would edit what a past notice said. `status = 'inactive'` is the reversible
-- switch that exists instead — the failure workflow resolves the list at send
-- time and takes only active rows, so a company deactivated yesterday is not in
-- today's email while its record stays where it was.
--
-- The Super-Admin policy below reads `FOR ALL` and still cannot delete: the
-- GRANTs above are what withhold DELETE from `authenticated`, and no policy can
-- hand back a privilege that was never granted. Postgres policies take one
-- command or all of them, so `FOR ALL` describes the policy's own scope; the
-- effective access is the intersection of that and the grant. Anything that
-- wants to change it has to change the grant, in a migration of its own.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.repair_companies TO authenticated;--> statement-breakpoint

GRANT INSERT (
  water_purveyor_id, company_name, phone, email, status
) ON public.repair_companies TO authenticated;--> statement-breakpoint

GRANT UPDATE (
  company_name, phone, email, status
) ON public.repair_companies TO authenticated;--> statement-breakpoint

CREATE POLICY "repair_companies_all_super_admin" ON public.repair_companies
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "repair_companies_select_own_wp" ON public.repair_companies
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

CREATE POLICY "repair_companies_insert_own_wp" ON public.repair_companies
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

-- Both halves are needed and they are not the same check. USING decides which
-- rows can be reached; WITH CHECK decides what they may be turned into. Without
-- the second, a WP could hand its own repair company to another purveyor by
-- writing a different `water_purveyor_id` — a row that leaves the tenant it was
-- read in.
CREATE POLICY "repair_companies_update_own_wp" ON public.repair_companies
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  )
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );
