-- ---------------------------------------------------------------------------
-- test_submissions
--
-- Row policies for the WP submitted-tests screen. RLS was enabled on the table
-- in 0000; until now it had no policies, so nothing reaching it through
-- PostgREST could see a row. These open exactly the WP-scoped paths § 6.6.6
-- needs and nothing else.
--
-- This is the most access-sensitive table in the schema, and the reason is that
-- two different immutability rules meet on it:
--
--   * A certifier may edit a test only while it is a draft. At submit the
--     record locks for them permanently (PRD § 8); their only path to change a
--     submitted test is re-running the wizard for the same BIN, which files a
--     *new* row. So nothing below gives a certifier a write path to a submitted
--     record — not a narrow one, not their own.
--   * The purveyor who receives the submission may correct any field on it
--     (§ 9, "Correcting a submitted test" — confirmed full field-level edit).
--     Every such correction is attributed, which is what the trigger at the
--     bottom of this file guarantees for a client session.
--
-- And drafts run the other way. A draft is the certifier's working copy of a
-- test that has not been attested to, so every WP-facing policy here carries
-- `status = 'submitted'`. A WP cannot list one, cannot read one by naming its
-- id, and cannot write one.
--
-- Caller resolution goes through the two SECURITY DEFINER helpers from 0001, as
-- redefined by 0006, so a blocked profile — and a blocked certifier — resolves
-- to NULL here as everywhere else and keeps no access.
--
-- Who gets what:
--
--   | Actor                  | SELECT                  | UPDATE                 |
--   |------------------------|-------------------------|------------------------|
--   | Super-Admin            | every row, both states   | every row, both states |
--   | WP Admin / SubAdmin    | own WP, submitted only   | own WP, submitted only |
--   | WP Employee            | own WP, submitted only   | nothing                |
--   | Certifier              | nothing (see below)      | nothing                |
--   | Blocked profile        | nothing                  | nothing                |
--
-- **The WP Admin/SubAdmin versus Employee split is a product decision taken
-- for this screen only.** PRD § 10 records the SubAdmin/Employee difference as
-- an open question, and § 6.6.3 already took the same narrow answer for
-- `certifiers.status`. Correcting a submitted test rewrites the legal record of
-- a backflow test, so the reversible direction is the one shipped: an Employee
-- reads, an Admin or SubAdmin corrects. Widening it later is one predicate in
-- `test_submissions_update_own_wp` plus one in
-- `wpSubmissionEditorProcedure`; narrowing it later takes access away from
-- people who had it. Nothing outside this file and that procedure inherits the
-- choice.
--
-- No certifier policy at all, deliberately, and the same call 0004 made for
-- `bfa_assets`: the certifier read path — their own drafts and their own
-- submitted archive, § 6.3 — belongs with the wizard that creates those rows
-- and gets its own migration. Until then the table is invisible to them, which
-- is the failing-closed direction.
--
-- The grants are column lists rather than a bare table grant, the same way
-- `bfa_assets` is written in 0004. Five columns are deliberately withheld from
-- UPDATE:
--
--   * `water_purveyor_id` — a submission never changes tenant. The WITH CHECK
--     below says the same thing a second time, on purpose: if a later migration
--     widens the grant, the policy is what still refuses.
--   * `status` — a WP correcting a test must not be able to reopen it as a
--     draft, which would hand a locked record back to the certifier and remove
--     it from the only screen that can still reach it.
--   * `certifier_id` — who performed the test is not a detail of the test. A
--     correction able to move a submission onto a different certifier could
--     move a failed test onto somebody who never attended it.
--   * `overridden_fields` — the certifier's record of which prefilled values
--     they overwrote, which exists so a WP can *see* what changed (§ 9). A WP
--     able to rewrite it could clear the flags rather than answer them.
--   * `edited_by_wp_profile_id` — the audit attribution. It is not withheld
--     because a client does not need it written; it is withheld because a
--     client must not choose its value. The trigger below writes it instead.
--
-- Two more are withheld without needing an argument about authority.
-- `current_step` is where a *draft* resumes, which is the certifier's wizard
-- state and meaningless on a finished record; `superseded_by_submission_id` is
-- set when a certifier re-runs the wizard for the same BIN, by the wizard.
--
-- No INSERT for anybody, Super-Admin included. A submission is created by the
-- certifier wizard through the privileged connection; a row inserted through
-- PostgREST would be a test nobody performed. No DELETE either — a submitted
-- test is evidence, and the product has no gesture that removes one.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.test_submissions TO authenticated;--> statement-breakpoint

GRANT UPDATE (
  bfa_asset_id, bfa_type, wizard_data, submitted_bin_text, test_date,
  test_result, signature_method, signature_data
) ON public.test_submissions TO authenticated;--> statement-breakpoint

CREATE POLICY "test_submissions_all_super_admin" ON public.test_submissions
  FOR ALL TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin')
  WITH CHECK ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

-- All three WP roles read. `status = 'submitted'` is what keeps a draft out of
-- the list *and* off the detail path: a WP naming a draft's id directly gets no
-- row, which is why `getSubmittedTest` can return the same "not found" for a
-- draft, a foreign row and an id that never existed.
CREATE POLICY "test_submissions_select_own_wp" ON public.test_submissions
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
    AND status = 'submitted'
  );--> statement-breakpoint

-- Admin and SubAdmin correct. Both halves are needed and they are not the same
-- check: USING decides which rows can be reached, WITH CHECK decides what they
-- may be turned into. Repeating `status = 'submitted'` in WITH CHECK is what
-- refuses an update that would move a row out of submitted state even if the
-- column grant were later widened.
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
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attribution, for client sessions.
--
-- "Every correction sets `edited_by_wp_profile_id`" is a rule the tRPC
-- procedure keeps for the application connection. This is the same rule for the
-- other connection — and it cannot be a grant, because a grant can only decide
-- whether the column is writable at all, and both answers are wrong here: grant
-- it and a caller can attribute their edit to a colleague; withhold it and a
-- correction arriving through PostgREST is an unattributed change to a legal
-- record.
--
-- So the column stays out of the grant and the trigger writes it, from
-- `auth.uid()` rather than from anything in the statement. Same shape as
-- `private.enforce_certifier_column_permissions()` in 0007: SECURITY DEFINER,
-- `private`-schema, and a no-JWT statement is left alone because that is the
-- privileged connection, for which the procedure layer is the boundary exactly
-- as it is for every other table in this schema.
--
-- An unchanged row is left alone too. A `set ... where` that writes the values
-- already present is not a correction, and stamping an editor onto it would
-- make the column name the last person to have *touched* the row rather than
-- the last to have changed it. The procedure declines to issue that statement
-- at all; this is the same judgement for a statement arriving another way.
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
  -- Not a client session: the privileged Drizzle connection, which bypasses RLS
  -- too. Adding a rule here would enforce on one connection what the policies
  -- beside it do not enforce on the other.
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- Nothing changed, so there is nothing to attribute. `IS DISTINCT FROM` on
  -- the whole row treats two NULLs as equal, which is what a column-by-column
  -- comparison would have to spell out.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  NEW.edited_by_wp_profile_id := actor;

  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.stamp_submission_editor() FROM PUBLIC;--> statement-breakpoint

-- Named to sort before `set_updated_at`, which is also BEFORE UPDATE on this
-- table: Postgres fires same-timing triggers in name order, and the attribution
-- belongs on the row before anything else has had an opinion about it.
CREATE TRIGGER attribute_wp_editor
  BEFORE UPDATE ON public.test_submissions
  FOR EACH ROW
  EXECUTE FUNCTION private.stamp_submission_editor();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The index this screen's ordering reads. The one schema change in this
-- migration, so it is declared in `schema/test-submissions.ts` and this
-- statement is `drizzle-kit generate`'s own output rather than hand-written —
-- the snapshot beside it has to agree, or the next generate would emit it a
-- second time.
--
-- 0000 gave the table `(water_purveyor_id)` and `(certifier_id, status)`. The
-- first is the tenant filter and the second is the certifier dashboard's; the
-- WP list filters on tenant *and* status and then orders by `test_date DESC`,
-- which the tenant-only index can narrow but not sort.
--
-- Column order matters: the two equality predicates first, then the sort
-- columns in the order the screen reads them, so Postgres can walk the index
-- and skip the sort rather than reading every submitted row for the tenant and
-- sorting it. `DESC NULLS LAST` matches `newestTestFirst` exactly — an index
-- can be scanned backwards, but the null placement has to agree or it cannot.
-- `id`, the third tie-break, is left off: two rows sharing a tenant, a date and
-- a microsecond timestamp is not a case worth a wider index.
-- ---------------------------------------------------------------------------
CREATE INDEX "test_submissions_wp_status_test_date_idx" ON "test_submissions" USING btree ("water_purveyor_id","status","test_date" DESC NULLS LAST,"created_at" DESC NULLS LAST);
