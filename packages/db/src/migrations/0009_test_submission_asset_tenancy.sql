-- ---------------------------------------------------------------------------
-- test_submissions — two corrections to 0008
--
-- A separate migration rather than an edit to `0008_test_submission_policies`,
-- because that one has already been applied. Both objects below are replaced
-- outright, so running this on a database that has 0008 leaves it in the same
-- state as one that got both from scratch.
--
-- Neither correction changes who may do what. Admin and SubAdmin still correct
-- submitted tests in their own purveyor and link one to an asset; Employee is
-- still read-only; a certifier still has no write path; Super-Admin is
-- untouched. What changes is that two rules 0008 stated in prose are now
-- actually enforced on the PostgREST side.
--
-- ---------------------------------------------------------------------------
-- 1. Cross-tenant asset linking (the reason this migration exists)
--
-- `bfa_asset_id` is in 0008's `GRANT UPDATE` column list, and it has to be:
-- resolving a no-BIN submission to an assembly is the one write this screen
-- makes to that column. But `test_submissions_update_own_wp` only ever checked
-- the tenancy of the *submission*, never of the asset being attached to it.
--
-- So a WP Admin or SubAdmin could satisfy every clause of that policy — their
-- own purveyor, a submitted row — while pointing `bfa_asset_id` at an asset
-- belonging to somebody else. Nothing refused it, and the damage is not
-- hypothetical: `listSubmittedTests` and `getSubmittedTest` both LEFT JOIN
-- `bfa_assets` through that column and return `bin` and `service_address` from
-- it. The join runs on the privileged connection, which bypasses RLS, so the
-- foreign asset's BIN and street address would come straight back on a row the
-- caller is entitled to read. A tenancy hole in a write turning into a read
-- leak one join later.
--
-- `linkSubmissionAsset` already refuses this — it looks the asset up inside the
-- caller's own purveyor, so a foreign one is never found rather than rejected.
-- That is the application boundary and it was never the gap. The gap is the
-- second boundary: anything arriving through PostgREST met a policy that had an
-- opinion about the row's tenant and none about the asset's.
--
-- The new clause goes in WITH CHECK only, not in USING. USING decides which
-- rows can be reached and WITH CHECK decides what they may be turned into, and
-- these are genuinely different questions here: a row whose `bfa_asset_id`
-- somehow already points across tenants is exactly a row a purveyor needs to be
-- able to open and repair. Putting the clause in USING would make the damaged
-- row unreachable and therefore unfixable.
--
-- `bfa_asset_id IS NULL` stays valid. An unresolved submission is the normal
-- state for the no-BIN flow (PRD § 7, flow 2) — most of what this screen exists
-- to work through arrives that way — and every other correction on such a row
-- leaves the column NULL.
--
-- The EXISTS names `water_purveyor_id` explicitly even though the subquery is
-- itself subject to `bfa_assets`' own row policies, which already restrict a WP
-- role to their own tenant. Both, deliberately: the same belt-and-braces
-- 0004 uses for `customer_assignments`, so this policy keeps refusing even if
-- the asset policies are later widened.
-- ---------------------------------------------------------------------------
DROP POLICY "test_submissions_update_own_wp" ON public.test_submissions;--> statement-breakpoint

CREATE POLICY "test_submissions_update_own_wp" ON public.test_submissions
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin')
    AND water_purveyor_id = (SELECT private.current_wp_id())
    AND status = 'submitted'
  )
  WITH CHECK (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin')
    AND water_purveyor_id = (SELECT private.current_wp_id())
    AND status = 'submitted'
    AND (
      bfa_asset_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.bfa_assets a
        WHERE a.id = test_submissions.bfa_asset_id
          AND a.water_purveyor_id = (SELECT private.current_wp_id())
      )
    )
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. A no-op update is not an update
--
-- 0008's trigger declined to *attribute* a statement that changed nothing, on
-- the grounds that `edited_by_wp_profile_id` must name the last person to have
-- changed a test rather than the last to have touched it. That reasoning was
-- right and the implementation was half of it: returning NEW let the statement
-- proceed, and `set_updated_at` — the other BEFORE UPDATE trigger on this table,
-- from 0000 — then set `updated_at = now()` unconditionally. So a no-op arriving
-- through PostgREST left the attribution alone and moved the timestamp anyway,
-- which is the same lie in the other column: `updated_at` coming to mean "when
-- somebody last pressed save".
--
-- Returning NULL from a BEFORE UPDATE row trigger skips the operation for that
-- row entirely — no write, no new row version, and no later trigger runs. It is
-- what `contrib/suppress_redundant_updates_trigger` does, and it is the only
-- answer that reaches `set_updated_at`, because a trigger cannot un-set a column
-- a trigger after it is going to assign.
--
-- The caller sees an UPDATE affecting zero rows, and RETURNING yields nothing.
-- That is honest rather than awkward: nothing was written.
--
-- **Trigger order is load-bearing, in both directions.** Postgres fires
-- same-timing row triggers in name order, and `attribute_wp_editor` sorts before
-- `set_updated_at`. That is what lets this function compare NEW against OLD at
-- all — had `set_updated_at` run first, it would have already assigned
-- `NEW.updated_at = now()`, no NEW would ever be "not distinct from" its OLD,
-- and the no-op branch would be dead code that silently never fired. And it is
-- what lets the NULL return suppress the timestamp, since a trigger that has not
-- run yet is one that can be skipped. Renaming either trigger breaks both halves
-- quietly, which is why this paragraph is here.
--
-- The privileged Drizzle connection is still left alone, as in 0008. It bypasses
-- RLS, so the tRPC procedure layer is its boundary — and `updateSubmittedTest`
-- already declines to issue a statement that changes nothing, with its own test.
-- Suppressing there too would also change what `.returning()` hands back to the
-- application, turning a redundant write into a not-found; the procedure's own
-- guard is the right place for that decision, and it makes it.
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
  -- Not a client session: the privileged connection, whose boundary is the
  -- procedure layer. Adding a rule here would enforce on one connection what
  -- the policies beside it do not enforce on the other.
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- Nothing changed, so there is nothing to attribute and nothing to write.
  -- NULL skips the row: no new version, and `set_updated_at` never runs.
  -- `IS NOT DISTINCT FROM` on the whole row treats two NULLs as equal, which a
  -- column-by-column comparison would have to spell out.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;

  NEW.edited_by_wp_profile_id := actor;

  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.stamp_submission_editor() FROM PUBLIC;
