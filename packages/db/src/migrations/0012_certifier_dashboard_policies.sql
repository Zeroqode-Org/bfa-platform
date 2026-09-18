-- ---------------------------------------------------------------------------
-- test_submissions — the certifier's own read/write path
--
-- Row policies for the certifier dashboard (§ 6.3). 0008 gave this table its
-- first policies and deliberately left the certifier out of them: "the
-- certifier read path — their own drafts and their own submitted archive —
-- belongs with the wizard that creates those rows and gets its own
-- migration." This is that migration. It is additive — nothing here touches
-- the Super-Admin or WP policies from 0008/0009.
--
-- The rule is the mirror image of the WP one. A WP may read and correct a
-- submitted row but never touch a draft; a certifier may read a row at either
-- status but write or delete only their own draft. Once submitted, a
-- certifier's record locks for them permanently (PRD § 8) — their only path
-- to change one is re-running the wizard for the same BIN, which files a new
-- row, not an edit to this one.
--
--   | Actor      | SELECT              | UPDATE           | DELETE     |
--   |------------|---------------------|------------------|------------|
--   | Certifier  | own rows, any status| own draft only   | own draft  |
--   | WP roles   | unchanged from 0008 | unchanged        | none       |
--   | Super-Admin| unchanged           | unchanged        | unchanged  |
--
-- `private.current_certifier_id()` is the new caller-resolution helper this
-- adds, the same STABLE/SECURITY DEFINER shape as `current_wp_id()` in 0006:
-- it resolves to NULL for anybody without an active `certifiers` row —
-- including a blocked profile or a blocked certifier — so every policy below
-- inherits the same failing-closed behavior the rest of the schema has.
--
-- The column grant is additive to 0008's, and that is exactly why this
-- migration needs a trigger it would not otherwise need. A Postgres grant is
-- held by the `authenticated` role, which every signed-in caller shares —
-- 0007 hit this same trap on `certifiers` and fixed it the same way. Widening
-- the grant to give a certifier `current_step`/`overridden_fields` also
-- widens it for a WP session, whose row policy's WITH CHECK says nothing
-- about columns; and giving a certifier the already-WP-granted
-- `bfa_asset_id` would let them attach an asset themselves, which is the WP's
-- job (§ 7, no-BIN flow) and not this task's to hand over. Both are narrowed
-- back per caller by `private.enforce_test_submission_column_permissions()`
-- below.
--
-- `status`, `certifier_id`, `water_purveyor_id`, `edited_by_wp_profile_id`
-- and `superseded_by_submission_id` stay out of the grant entirely, for the
-- same reasons 0008 gives for each: a submission does not change tenant or
-- certifier through this path, a certifier cannot self-promote a draft to
-- submitted, attribution is not a client-supplied value, and superseding a
-- row is the wizard's decision, not this screen's.
--
-- DELETE is new — 0008 granted none at all, on the grounds that "a submitted
-- test is evidence, and the product has no gesture that removes one." A
-- draft is not evidence of anything yet, and build-plan § 6.3 asks for
-- exactly this: "a certifier may delete their own draft." The grant and the
-- policy below both stop at `status = 'draft'`, so nothing here reopens that
-- question for a submitted row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.current_certifier_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id
  FROM public.certifiers c
  JOIN public.profiles p ON p.id = c.profile_id
  WHERE p.id = (SELECT auth.uid())
    AND p.status = 'active'
    AND c.status = 'active';
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.current_certifier_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.current_certifier_id() TO authenticated;--> statement-breakpoint

GRANT UPDATE (
  current_step, overridden_fields
) ON public.test_submissions TO authenticated;--> statement-breakpoint

GRANT DELETE ON public.test_submissions TO authenticated;--> statement-breakpoint

-- Any status, own rows only. A certifier's submitted archive (§ 6.3's
-- "Submitted PDFs") is read through this same policy — there is no separate
-- status-scoped one, because unlike the WP screens a certifier is entitled to
-- their own drafts too.
CREATE POLICY "test_submissions_select_own_certifier" ON public.test_submissions
  FOR SELECT TO authenticated
  USING (certifier_id = (SELECT private.current_certifier_id()));--> statement-breakpoint

-- USING and WITH CHECK repeat the same clause on purpose, the same reasoning
-- 0008 gives for the WP policy: WITH CHECK is what still refuses an update
-- that would move a row out of draft state if the column grant is ever
-- widened to include `status`.
CREATE POLICY "test_submissions_update_own_draft_certifier" ON public.test_submissions
  FOR UPDATE TO authenticated
  USING (
    certifier_id = (SELECT private.current_certifier_id())
    AND status = 'draft'
  )
  WITH CHECK (
    certifier_id = (SELECT private.current_certifier_id())
    AND status = 'draft'
  );--> statement-breakpoint

CREATE POLICY "test_submissions_delete_own_draft_certifier" ON public.test_submissions
  FOR DELETE TO authenticated
  USING (
    certifier_id = (SELECT private.current_certifier_id())
    AND status = 'draft'
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Closing a gap this migration would otherwise reopen.
--
-- `test_submissions_all_super_admin` (0008) is `FOR ALL`, which includes
-- DELETE — it had no effect before this migration because nothing had
-- granted `authenticated` the DELETE privilege on this table at all, and a
-- grant is a stronger, prior gate than any policy. This migration's own
-- `GRANT DELETE` makes that policy newly live for DELETE, and — being
-- table-wide, since DELETE has no column-list form the way UPDATE grants
-- above are scoped — it would let a Super-Admin delete *any* row, including
-- a submitted one. 0008 closed that door on purpose: "a submitted test is
-- evidence, and the product has no gesture that removes one."
--
-- A permissive policy cannot be narrowed by adding another permissive one —
-- multiple permissive policies for the same command OR together, so a second
-- one can only widen access, never restrict it. A RESTRICTIVE policy is the
-- other kind: it ANDs against every permissive policy for the same command,
-- which is exactly the shape of "no matter who the permissive policy says
-- yes to, the row still has to be a draft." It does not touch 0008 at all —
-- the fix lives entirely in this migration, on top of a policy it leaves
-- alone.
-- ---------------------------------------------------------------------------
CREATE POLICY "test_submissions_delete_draft_only" ON public.test_submissions
  AS RESTRICTIVE
  FOR DELETE TO authenticated
  USING (status = 'draft');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Per-role column enforcement, now that the grant is shared.
--
-- Same shape as `private.enforce_certifier_column_permissions()` in 0007: a
-- no-JWT statement is the privileged Drizzle connection and is left alone,
-- Super-Admin is unrestricted, and every other role is narrowed to the
-- columns this migration's reasoning actually grants it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.enforce_test_submission_column_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := (SELECT auth.uid());
  actor_role public.global_role;
BEGIN
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  actor_role := (SELECT private.current_global_role());

  IF actor_role = 'super_admin' THEN
    RETURN NEW;
  END IF;

  -- A WP correction never touches a certifier's draft-resume state. Neither
  -- column is granted for anyone but this trigger's other branch, but the
  -- grant is shared, not per-role, so the refusal has to be too.
  IF actor_role IN ('wp_admin', 'wp_sub_admin') THEN
    IF NEW.current_step IS DISTINCT FROM OLD.current_step
       OR NEW.overridden_fields IS DISTINCT FROM OLD.overridden_fields THEN
      RAISE EXCEPTION
        'A water purveyor cannot change a certifier''s draft-resume state'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- A certifier saving their own draft. `bfa_asset_id` is withheld even
  -- though 0008 already granted the column — resolving the no-BIN flow is
  -- the WP's job (§ 7), and this migration does not hand it over.
  IF actor_role = 'certifier' THEN
    IF NEW.bfa_asset_id IS DISTINCT FROM OLD.bfa_asset_id THEN
      RAISE EXCEPTION
        'A certifier cannot attach an asset to their own submission'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- Unreachable through the policies as written, the same fail-closed
  -- backstop 0007's trigger keeps for the same reason.
  RAISE EXCEPTION 'Not permitted to update this test submission'
    USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.enforce_test_submission_column_permissions() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER enforce_column_permissions
  BEFORE UPDATE ON public.test_submissions
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_test_submission_column_permissions();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Correcting a real gap this migration would otherwise open.
--
-- `private.stamp_submission_editor()` (0008, corrected in 0009 to `RETURN
-- NULL` on a no-op — see that migration for why the NULL return and the
-- `attribute_wp_editor` / `set_updated_at` trigger-name order are both
-- load-bearing) stamps `edited_by_wp_profile_id` from `auth.uid()` on any
-- changed row, reached by anyone whose UPDATE policy lets them touch the
-- table at all — because until now only a WP session could. This migration
-- gives a certifier a second write path onto the same table, and the
-- trigger would misattribute a certifier's own draft save as a WP edit.
-- Redefined here to only stamp when the actor resolves to a WP role, which
-- is what the column was always meant to record — 0009's no-op suppression
-- is carried forward unchanged, not re-derived, so this does not silently
-- undo it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.stamp_submission_editor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := (SELECT auth.uid());
BEGIN
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;

  IF (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin') THEN
    NEW.edited_by_wp_profile_id := actor;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two indexes this screen's list queries read, one per sort order
-- (`listDrafts` by `updated_at`, `listSubmissions` by `test_date`) — declared
-- in `schema/test-submissions.ts` and generated by `drizzle-kit generate`
-- rather than hand-written, so the snapshot beside it agrees.
--
-- `drizzle-kit generate` also re-emitted three statements for indexes that
-- already exist on the database
-- (`bfa_assets_wp_past_due_customer_idx`, `customers_water_purveyor_id_email_key`,
-- `repair_companies_water_purveyor_id_email_key`) — verified directly against
-- `pg_indexes`. The migrations that hand-added those never had their
-- snapshots regenerated to match, so the tool's diff still sees them as
-- missing. Removed here so this migration does not fail on "already exists";
-- fixing the drift itself is a separate cleanup, not this one's.
-- ---------------------------------------------------------------------------
CREATE INDEX "test_submissions_certifier_status_updated_idx" ON "test_submissions" USING btree ("certifier_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "test_submissions_certifier_status_test_date_idx" ON "test_submissions" USING btree ("certifier_id","status","test_date" DESC NULLS LAST,"created_at" DESC NULLS LAST);
