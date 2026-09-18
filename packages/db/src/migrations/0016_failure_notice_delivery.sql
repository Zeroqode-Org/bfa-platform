-- ---------------------------------------------------------------------------
-- Workflow 3 — the failure notice's durable delivery, and the fail list's
-- history index
--
-- Fail-list membership itself ships with NO storage: an asset is on the list
-- exactly while its latest submitted, resulted test is a fail, computed from
-- `test_submissions` at read time. Nothing here is a membership flag, and the
-- pre-declared `fail_list_check` job type stays deliberately unused — there is
-- no delay to schedule and no stored state to recheck.
--
-- 1. `job_type` gains `failure_notice`
--
-- The failure email is not sent inline from the mutation that records the
-- fail: an email is an external side effect Postgres cannot enrol in the
-- transaction, and the scheduler already owns the machinery that makes a send
-- survive crashes without duplicating — the frozen payload, the provider
-- idempotency key, retry with backoff, and startup recovery (0014/0015). So
-- the mutation queues one `failure_notice` job, due immediately, in its own
-- transaction, and the scheduler delivers it. A rolled-back correction leaves
-- no job behind; a crashed send is retried under the same key.
--
-- Appended with ADD VALUE and never referenced later in this file, because a
-- value added inside a transaction cannot be used until it commits.
--
-- 2. `scheduled_jobs.test_submission_id`
--
-- A failure notice answers one submitted failing test, so the job carries the
-- submission, not the asset. Deliberately: `scheduled_jobs_live_asset_job_type_key`
-- allows only one live job per (asset, type), and two failing submissions for
-- one assembly in quick succession are two notices, not one. The handler
-- resolves the asset — and the recipient, and the repair companies — from the
-- submission at send time, never from values remembered at scheduling time.
--
-- 3. The settled-submission constraint
--
-- At most one job per (submission, type) in any status except `cancelled`.
-- Stricter than the live-job rule on purpose: once a submission's failure
-- notice is completed (or terminally failed), a later correction that touches
-- the row must not queue a second email about the same fail — the upsert hits
-- this index and does nothing. Only a cancellation (the fail was corrected
-- away) frees the slot, so correcting a result to pass and back to fail earns
-- exactly one fresh notice. Its leading column doubles as the lookup index for
-- a submission's jobs.
--
-- 4. `test_submissions_asset_result_event_idx`
--
-- The fail list's real query shape: per asset, walk the submitted rows that
-- carry a result in submission-event order — `(created_at, id)`, because
-- `test_date` is nullable and certifier-typed — asking "which fails have no
-- later pass". The failure-notice handler asks the same question at send time.
-- Partial on exactly that shared predicate so it stays off drafts and
-- unresulted or unlinked rows.
--
-- Access is unchanged on both tables. `scheduled_jobs` writes still all come
-- from the service-role scheduler process — no INSERT/UPDATE/DELETE grant
-- exists to extend — and 0014's table-level SELECT for the purveyor's own WP
-- roles and the Super-Admin covers the new column: which of their own
-- submissions a notice answers is exactly what "did the email go out" needs.
-- No RLS policy references specific columns, so none changes.
-- ---------------------------------------------------------------------------
ALTER TYPE public.job_type ADD VALUE 'failure_notice';--> statement-breakpoint

ALTER TABLE public.scheduled_jobs
  ADD COLUMN "test_submission_id" uuid REFERENCES public.test_submissions(id);--> statement-breakpoint

CREATE UNIQUE INDEX "scheduled_jobs_settled_submission_job_type_key"
  ON public.scheduled_jobs USING btree ("test_submission_id", "job_type")
  WHERE "test_submission_id" IS NOT NULL AND "status" <> 'cancelled';--> statement-breakpoint

CREATE INDEX "test_submissions_asset_result_event_idx"
  ON public.test_submissions USING btree ("bfa_asset_id", "created_at", "id")
  WHERE "status" = 'submitted' AND "test_result" IS NOT NULL AND "bfa_asset_id" IS NOT NULL;
