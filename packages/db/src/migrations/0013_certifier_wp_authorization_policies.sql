-- ---------------------------------------------------------------------------
-- wp_certifier_authorizations — the certifier's own read path
--
-- RLS policy for the WP selector (§ 6.4). RLS was enabled on this table in
-- 0000; until now it had no policies at all, so nothing reaching it through
-- PostgREST — WP roles included — could see a row. This migration opens
-- exactly the path § 6.4 needs and nothing else: a certifier reading their
-- own authorizations, at any status.
--
-- Any status, not just `active`. `listAuthorizedWps` (the tRPC procedure,
-- reading through the privileged Drizzle connection) is what filters to
-- `active` — the row policy's job is only "is this the caller's own row",
-- the same split `test_submissions_select_own_certifier` (0012) makes
-- between "which rows can this caller reach at all" (the policy) and "which
-- of those does this screen want" (the query).
--
-- WP-side management of this table (a purveyor inviting, revoking, or
-- listing their own authorizations through PostgREST) is a separate,
-- unshipped feature — no policy for `wp_admin`/`wp_sub_admin`/`wp_employee`
-- is added here. The existing `listWpCertifiers` procedure (§ 6.6.3) already
-- reads this table WP-side, but through the same privileged connection every
-- other WP procedure uses, so it needs no policy to keep working.
--
-- No INSERT, UPDATE or DELETE for anybody. A row here is created by invite
-- redemption (a new certifier's first authorization) or by the second-WP
-- invite path (an existing certifier invited by another purveyor) — both
-- through the privileged connection. Revoking one is a WP-side feature that
-- does not exist yet; when it ships, it gets its own migration, the same way
-- `0006`/`0007` gave `certifiers.status` its own grant and trigger rather
-- than assuming one from a read-only migration like this one.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.wp_certifier_authorizations TO authenticated;--> statement-breakpoint

CREATE POLICY "wp_certifier_authorizations_select_own_certifier" ON public.wp_certifier_authorizations
  FOR SELECT TO authenticated
  USING (certifier_id = (SELECT private.current_certifier_id()));
