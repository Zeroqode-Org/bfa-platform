-- ---------------------------------------------------------------------------
-- notice_templates
--
-- Row policies for the WP notices screen. RLS was enabled on the table in 0000;
-- until now it had no policies, so nothing reaching it through PostgREST could
-- see a row. These open exactly the WP-scoped paths the screen needs and
-- nothing wider.
--
-- Caller resolution goes through the two SECURITY DEFINER helpers from 0001
-- (`private.current_global_role()` / `private.current_wp_id()`), so a blocked
-- profile resolves to NULL here as it does everywhere else and keeps no access.
--
-- Super-Admin: read, insert and update across every tenant. All three WP roles
-- read their own purveyor's templates; only `wp_admin` writes one. That split is
-- narrower than `repair_companies` in 0005 on purpose — keeping the approved
-- repairer list current is clerk work, while rewriting a notice template changes
-- what every customer of the purveyor is sent in the purveyor's name.
--
-- Certifier: nothing at all. A certifier tests assemblies; what the purveyor
-- writes to its customers is not theirs to read or edit.
--
-- The grants are column lists rather than a bare table grant, the same way
-- `bfa_assets` is written in 0004 and `repair_companies` in 0005. Three columns
-- are deliberately missing from the UPDATE grant:
--
--   * `water_purveyor_id` — a template never changes tenant, so the privilege is
--     simply not handed over. The WITH CHECK below says the same thing a second
--     time, for the day a later migration widens the grant.
--   * `notice_type` — the pair (`water_purveyor_id`, `notice_type`) is the
--     template's identity. Re-typing an existing row is not an edit to it; it is
--     a different template, which the INSERT path already creates.
--   * `is_enabled` — the column exists and stays unwired. Automated notices are
--     switched on per purveyor by the Super-Admin through
--     `wp_feature_flags.automated_notices`; a per-notice-type switch is a control
--     with undefined behaviour until what disabling a middle step means for the
--     escalation chain is answered. Withholding the privilege is what keeps
--     "we did not build the toggle" from being only a UI decision.
--
-- No DELETE for anybody, Super-Admin included. Deleting a template is
-- indistinguishable from never having written one — the row's absence is what
-- means "this purveyor uses the platform default" — so there is nothing a delete
-- would express that rewriting the text does not. As in 0005, the Super-Admin
-- policy reads FOR ALL and still cannot delete: a policy cannot hand back a
-- privilege the grant never gave.
--
-- The unique constraint on (`water_purveyor_id`, `notice_type`) comes from 0000
-- and is what makes `upsertNoticeTemplate` an upsert rather than a race between
-- two saves.
--
-- One index, not a policy: the general-info broadcast's past-due audience asks
-- whether a customer owns any assembly the scheduler has marked `past_due`.
-- That is an EXISTS keyed on (`water_purveyor_id`, `current_customer_id`) with
-- `asset_status` fixed, so the index carries the two lookup columns and the
-- status lives in the predicate — a partial index over the small delinquent
-- slice rather than a third column across every asset row.
-- ---------------------------------------------------------------------------
CREATE INDEX "bfa_assets_wp_past_due_customer_idx"
  ON public.bfa_assets USING btree ("water_purveyor_id", "current_customer_id")
  WHERE "asset_status" = 'past_due';--> statement-breakpoint

GRANT SELECT ON public.notice_templates TO authenticated;--> statement-breakpoint

GRANT INSERT (
  water_purveyor_id, notice_type, subject, body
) ON public.notice_templates TO authenticated;--> statement-breakpoint

GRANT UPDATE (
  subject, body
) ON public.notice_templates TO authenticated;--> statement-breakpoint

CREATE POLICY "notice_templates_all_super_admin" ON public.notice_templates
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "notice_templates_select_own_wp" ON public.notice_templates
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

CREATE POLICY "notice_templates_insert_own_wp" ON public.notice_templates
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.current_global_role()) = 'wp_admin'
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

-- Both halves are needed and they are not the same check. USING decides which
-- rows can be reached; WITH CHECK decides what they may be turned into. Without
-- the second, a WP Admin could hand its own template to another purveyor by
-- writing a different `water_purveyor_id` — a row that leaves the tenant it was
-- read in. The column grant above already refuses that; this refuses it again.
CREATE POLICY "notice_templates_update_own_wp" ON public.notice_templates
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) = 'wp_admin'
    AND water_purveyor_id = (SELECT private.current_wp_id())
  )
  WITH CHECK (
    (SELECT private.current_global_role()) = 'wp_admin'
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );
