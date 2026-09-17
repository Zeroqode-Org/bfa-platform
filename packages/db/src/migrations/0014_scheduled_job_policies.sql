-- ---------------------------------------------------------------------------
-- scheduled_jobs — the scheduler's own table
--
-- Three things ship here: the send marker the notice handler needs to be
-- idempotent, the constraint that makes "one live job per stage per asset" a
-- database fact, and the table's first row policies. RLS was enabled on it in
-- 0000; until now it had no policies, so nothing reaching it through PostgREST
-- could see a row.
--
-- 1. `sent_at`
--
-- An email is an external side effect and Postgres cannot enrol it in a
-- transaction, so "send the mail, then record that we did" has a window in it:
-- a process killed inside that window comes back, finds the job still claimable
-- and sends a second copy of a notice in the purveyor's name. `sent_at` closes
-- that window from the other side. The handler claims the *send* with
--
--     update scheduled_jobs set sent_at = now() where id = $1 and sent_at is null
--
-- and sends only if that statement matched a row. A crash after the send leaves
-- the marker set, so the retry skips the send and carries on to scheduling the
-- successor — no duplicate, ever. A send the provider *refuses* clears the
-- marker again before the error propagates, so a genuine delivery failure still
-- retries.
--
-- What that trades away is stated rather than hidden: a process killed between
-- the marker and the send loses that one notice, because the marker says it was
-- sent. The chain still advances and the customer still hears from the purveyor
-- at the next stage. Losing one notice of four is the better failure than
-- sending a customer a duplicate overdue warning, which is why the marker is
-- written first.
--
-- Nullable with no default and no backfill: a null means this job has not sent
-- anything, which is true of every row that exists today.
--
-- 2. The live-job constraint
--
-- A notice chain is derived entirely from `bfa_assets.annual_test_date`, so two
-- pending `reminder` rows for one asset are not two reminders — they are two
-- copies of the same one, and they would both fire. Two clerks saving a date
-- change at the same moment is enough to create them. A partial unique index
-- over the non-terminal statuses makes that unrepresentable, and gives the
-- reconciler an `on conflict` target so scheduling is an upsert rather than a
-- read-then-write race.
--
-- Partial on two counts. `status in ('pending','running')` is what lets a
-- completed reminder and next year's pending reminder coexist — the whole point
-- of the chain is that stages retire. And `bfa_asset_id is not null` keeps the
-- constraint off the job types that are not about one assembly; `ag_renewal` is
-- a customer-scoped notice and would otherwise be squeezed into an
-- asset-shaped rule it does not fit.
--
-- The claim path's index — (`status`, `run_at`) — is already in 0000. Cancelling
-- and reconciling an asset's chain reads (`bfa_asset_id`, `status`), which this
-- index serves with its leading column, so no second index ships here.
--
-- 3. Access
--
-- Read-only for everybody, with no exception for the Super-Admin. Every write
-- goes through the service-role scheduler process, which bypasses RLS entirely,
-- so there is no INSERT, UPDATE or DELETE grant to hand out — not a narrow one,
-- none. A job row is a record of what the platform did or is about to do; a user
-- editing one would be editing the audit trail of their own mail.
--
-- Super-Admin reads every tenant's rows. The three WP roles read their own
-- purveyor's, which is what the build plan asks for and is genuinely useful: "no
-- reminder arrived" is answered by looking at whether a job exists, whether it
-- is `cancelled` because the feature flag is off, or `failed` with a
-- `last_error`. A certifier gets nothing — whose assemblies are overdue and what
-- the purveyor sends them is not theirs to read.
--
-- Caller resolution goes through the two SECURITY DEFINER helpers from 0001
-- (`private.current_global_role()` / `private.current_wp_id()`), so a blocked
-- profile resolves to NULL here as everywhere else and keeps no access.
-- ---------------------------------------------------------------------------
ALTER TABLE public.scheduled_jobs ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint

CREATE UNIQUE INDEX "scheduled_jobs_live_asset_job_type_key"
  ON public.scheduled_jobs USING btree ("bfa_asset_id", "job_type")
  WHERE "status" IN ('pending', 'running') AND "bfa_asset_id" IS NOT NULL;--> statement-breakpoint

GRANT SELECT ON public.scheduled_jobs TO authenticated;--> statement-breakpoint

CREATE POLICY "scheduled_jobs_select_super_admin" ON public.scheduled_jobs
  FOR SELECT TO authenticated
  USING ((SELECT private.current_global_role()) = 'super_admin');--> statement-breakpoint

CREATE POLICY "scheduled_jobs_select_own_wp" ON public.scheduled_jobs
  FOR SELECT TO authenticated
  USING (
    (SELECT private.current_global_role()) IN ('wp_admin', 'wp_sub_admin', 'wp_employee')
    AND water_purveyor_id = (SELECT private.current_wp_id())
  );
