-- ---------------------------------------------------------------------------
-- Workflow 2 — the renewal date an `ag_renewal` job belongs to
--
-- The AG renewal notice is now an annual cycle: after a provider-confirmed
-- delivery to an active agricultural customer, the handler moves
-- `customers.ag_renewal_date` forward one calendar year and queues the next
-- job — but only if the customer's date is still the date the delivered
-- notice was *for*. A concurrent edit by the WP must win, and a retry of the
-- same job must never add a second year.
--
-- Nothing on the row durably records that date today. `run_at` is moved by
-- holds and retry backoff, and the frozen payload (which names the date in
-- its text) is cleared the moment the provider's answer is recorded (0015) —
-- exactly the moment the annual transition needs it. So the job carries it:
--
-- `scheduled_jobs.ag_renewal_date`
--
-- The `customers.ag_renewal_date` value the job was queued for, written once
-- at insert and never rewritten (a changed date cancels the job and inserts a
-- fresh one). The transition compares it with the customer's current date
-- under the customer's row lock, in the same transaction that completes the
-- job — which is what makes "advance at most once per job" a database fact
-- rather than a hope.
--
-- Backfilled for the live rows only, from the customer's current date: the
-- procedures already cancel a live job whenever that date changes, so for a
-- live row the two agree by construction. Terminal rows stay NULL — they are
-- history and will never run again. A live row whose customer has no date
-- stays NULL, and the handler cancels it rather than guessing.
--
-- The CHECK keeps the column where it means something: only `ag_renewal`
-- rows may carry it. Valid immediately — every existing row is NULL or an
-- AG job.
--
-- Access is unchanged: 0014/0017 grant table-level SELECT on this table to
-- `authenticated`, which covers a new column, and no INSERT/UPDATE/DELETE
-- grant exists. All writes stay with the service-role scheduler connection.
-- ---------------------------------------------------------------------------
ALTER TABLE public.scheduled_jobs ADD COLUMN "ag_renewal_date" date;--> statement-breakpoint

UPDATE public.scheduled_jobs AS j
   SET ag_renewal_date = c.ag_renewal_date
  FROM public.customers AS c
 WHERE j.customer_id = c.id
   AND j.job_type = 'ag_renewal'
   AND j.status IN ('pending', 'running');--> statement-breakpoint

ALTER TABLE public.scheduled_jobs
  ADD CONSTRAINT "scheduled_jobs_ag_renewal_date_only_on_ag_jobs"
  CHECK ("ag_renewal_date" IS NULL OR "job_type" = 'ag_renewal');
