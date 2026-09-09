CREATE INDEX "invitations_associated_wp_id_idx" ON "invitations" USING btree ("associated_wp_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Caller resolution for row policies.
--
-- Every policy in this project resolves the caller through their own `profiles`
-- row. Reading `profiles` from inside a policy *on* `profiles` recurses, so the
-- lookup lives in two SECURITY DEFINER helpers that bypass RLS. They are in a
-- `private` schema, which PostgREST does not expose, and they read nothing but
-- the caller's own row — there is no argument to point them at someone else.
--
-- A blocked profile resolves to NULL, so a blocked user keeps only the
-- `id = auth.uid()` paths and loses every role- or tenant-wide grant.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;--> statement-breakpoint

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
    AND p.status = 'active';
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
    AND p.status = 'active';
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.current_global_role() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.current_wp_id() FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA private TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.current_global_role() TO authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.current_wp_id() TO authenticated;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- profiles
--
-- Reads: own row, plus the whole platform for a Super-Admin and the whole WP
-- for a WP Admin or SubAdmin.
--
-- Writes: own row only, and the column grant below narrows that to `full_name`
-- — a row policy cannot stop a user from writing their own `global_role`,
-- `water_purveyor_id` or `status`, but a column grant can.
--
-- There is deliberately no INSERT policy and no INSERT grant. Profiles are
-- created by the invite-redemption path with the service-role key, which
-- bypasses RLS; anything else creating a profile is a bug, and the missing
-- policy is what makes it fail loudly.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.profiles TO authenticated;--> statement-breakpoint
GRANT UPDATE (full_name) ON public.profiles TO authenticated;--> statement-breakpoint

CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));--> statement-breakpoint

CREATE POLICY "profiles_select_super_admin" ON public.profiles
  FOR SELECT TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "profiles_select_own_wp" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin')
    AND water_purveyor_id IS NOT NULL
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- invitations
--
-- Super-Admin full. All three WP roles read and insert rows for their own WP —
-- inviting a certifier is not restricted to the Admin. The
-- `associated_wp_id IS NOT NULL` clause in the WP insert policy is what keeps
-- new-WP provisioning (a null WP) exclusive to the Super-Admin. Certifier gets
-- no policy at all, so the table is invisible to them.
--
-- Redemption never reads through these policies: it runs in a server action
-- with the service-role key, so a token is not enumerable from the client.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO authenticated;--> statement-breakpoint

CREATE POLICY "invitations_all_super_admin" ON public.invitations
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "invitations_select_own_wp" ON public.invitations
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND associated_wp_id IS NOT NULL
    AND associated_wp_id = (SELECT private.current_wp_id())
  );--> statement-breakpoint

CREATE POLICY "invitations_insert_own_wp" ON public.invitations
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND associated_wp_id IS NOT NULL
    AND associated_wp_id = (SELECT private.current_wp_id())
  );
