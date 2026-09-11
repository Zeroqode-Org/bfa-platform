-- ---------------------------------------------------------------------------
-- certifiers
--
-- Row policies for the WP certifiers screen. RLS was enabled on the table in
-- 0000; until now it had no policies, so nothing reaching it through PostgREST
-- could see a row. These open exactly the paths `/wp/certifiers` needs.
--
-- A certifier is not a tenant of a water purveyor. `certifiers` carries no
-- `water_purveyor_id` at all, and `profiles.water_purveyor_id` is deliberately
-- null for the role — the reach runs the other way, through
-- `wp_certifier_authorizations`, and a certifier working for two purveyors has
-- two rows there and one `certifiers` row. So every WP-facing policy below is
-- join-based rather than a column comparison, which is the whole reason this
-- table could not reuse the `water_purveyor_id = private.current_wp_id()`
-- shape that `customers`, `bfa_assets` and `repair_companies` are written in.
--
-- Super-Admin: read and update across every tenant. WP Admin, SubAdmin and
-- Employee read the certifiers authorized for their own purveyor; Admin and
-- SubAdmin also block and unblock them. A certifier reads their own row.
--
-- The grants are column lists rather than a bare table grant, the same way
-- `bfa_assets` is written in 0004 and `repair_companies` in 0005. UPDATE hands
-- over exactly one column — `status` — because that is the only thing this
-- feature writes. A Postgres policy cannot restrict which columns a statement
-- touches; the grant is the mechanism that can, so it is the one used. The
-- certifier's own profile columns (`company`, `id_number`,
-- `license_expiration_date`) are deliberately absent: certifier profile editing
-- is a separate feature and gets its own migration.
--
-- No INSERT and no DELETE for anybody. A `certifiers` row is created by invite
-- redemption through the privileged connection, which bypasses RLS, and
-- nothing in the product removes one — `status = 'blocked'` is the reversible
-- switch that exists instead. As in 0005, the Super-Admin policy reads
-- `FOR ALL` and still cannot insert or delete: a policy cannot hand back a
-- privilege the grant never gave.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Blocked certifiers lose their role, the same way blocked profiles already do.
--
-- The two `private` helpers from 0001 resolve a caller to NULL when their
-- profile is blocked, and every role- or tenant-wide policy in the schema is
-- written on top of that. A certifier has a second switch — `certifiers.status`
-- — which is the one this screen writes, and until now it meant nothing outside
-- the WP's own table.
--
-- Both helpers are redefined here so it means the same thing as the first
-- switch: a blocked certifier resolves to NULL and keeps only the
-- `id = auth.uid()` paths. Without this, `setCertifierStatus` would set a flag
-- the database itself did not act on, and "blocked" would be a label in one
-- table rather than a loss of access. `resolveCaller` in
-- `packages/api/src/context.ts` enforces the same rule for the application
-- connection, which bypasses RLS entirely.
--
-- The lookup is a NOT EXISTS rather than a join: `certifiers.profile_id` is
-- unique, and every non-certifier profile has no row there at all, so the
-- clause has to leave those callers untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.current_global_role()
RETURNS public.global_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.global_role
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM public.certifiers c
      WHERE c.profile_id = p.id
        AND c.status = 'blocked'
    );
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION private.current_wp_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.water_purveyor_id
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM public.certifiers c
      WHERE c.profile_id = p.id
        AND c.status = 'blocked'
    );
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Is this certifier authorized for the caller's own purveyor?
--
-- The join lives in a SECURITY DEFINER helper rather than inline in the policy,
-- for the same reason the caller-resolution helpers do.
-- `wp_certifier_authorizations` has RLS enabled and no policies of its own, and
-- a table referenced from inside a policy expression is still subject to its
-- own RLS — so an inline EXISTS over it would read zero rows and refuse every
-- WP caller. Authorization management is a separate feature; this keeps that
-- table's policies out of this migration.
--
-- There is no argument that points it at another purveyor: the tenant comes
-- from `private.current_wp_id()`, which reads only the caller's own profile.
-- That returns NULL for a Super-Admin, a certifier and any blocked profile, and
-- `water_purveyor_id = NULL` is never true, so the helper answers false for
-- everyone who is not a WP role — the role check in each policy below says the
-- same thing again, explicitly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.certifier_in_current_wp(p_certifier_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.wp_certifier_authorizations a
    WHERE a.certifier_id = p_certifier_id
      AND a.water_purveyor_id = (SELECT private.current_wp_id())
  );
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.certifier_in_current_wp(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.certifier_in_current_wp(uuid) TO authenticated;--> statement-breakpoint

GRANT SELECT ON public.certifiers TO authenticated;--> statement-breakpoint

-- One column, deliberately. This is what makes "a WP may update only
-- `certifiers.status`" enforceable in the database — no row policy can express
-- it, and without the grant the procedure layer would be the only thing saying
-- it.
GRANT UPDATE (status) ON public.certifiers TO authenticated;--> statement-breakpoint

CREATE POLICY "certifiers_all_super_admin" ON public.certifiers
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

-- A certifier's own row, keyed on `auth.uid()` rather than on the resolved
-- role, exactly like `profiles_select_own` in 0001. Read only: updating one's
-- own company or license is certifier profile editing, which is a different
-- feature, and `status` is not the certifier's to write in any case.
CREATE POLICY "certifiers_select_self" ON public.certifiers
  FOR SELECT TO authenticated
  USING (profile_id = (SELECT auth.uid()));--> statement-breakpoint

-- All three WP roles read. Keeping the list current is clerk work, and the
-- reminder email a WP sends names the certifiers a customer can call.
CREATE POLICY "certifiers_select_own_wp" ON public.certifiers
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND private.certifier_in_current_wp(id)
  );--> statement-breakpoint

-- Blocking is not clerk work: it takes somebody's access to the platform away.
-- `wp_employee` is absent from this policy and present in the one above, which
-- is the only place the three WP roles differ on this table.
--
-- USING and WITH CHECK are not the same question — which rows can be reached,
-- and what they may be turned into. Both are the same expression here because
-- the update cannot move a row between tenants: `certifiers` has no
-- `water_purveyor_id`, and the only granted column is `status`. The WITH CHECK
-- is what keeps that true if a later migration widens the grant.
CREATE POLICY "certifiers_update_status_own_wp" ON public.certifiers
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin')
    AND private.certifier_in_current_wp(id)
  )
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin')
    AND private.certifier_in_current_wp(id)
  );
