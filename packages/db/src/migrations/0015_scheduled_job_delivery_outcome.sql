-- ---------------------------------------------------------------------------
-- scheduled_jobs — a durable, provider-confirmed delivery outcome
--
-- Supersedes the delivery model 0012 introduced. 0012 added `sent_at` and wrote
-- it *before* calling the email provider, treating the marker as proof the mail
-- had gone out. A process killed between that write and the send therefore
-- lost the notice silently: the retry saw the marker, skipped the send, and
-- advanced the chain. Automated notices are the product, so "occasionally skip
-- one" is not an acceptable degradation, and `sent_at` is removed here rather
-- than left behind as a column that claims something it cannot know.
--
-- The replacement rests on the provider's own idempotency mechanism. Resend
-- (`POST /emails`, `Idempotency-Key` header, SDK option `idempotencyKey`)
-- de-duplicates requests carrying the same key for 24 hours: a replay returns
-- the *original* email id and sends nothing, and a replay whose payload differs
-- from the original is refused with 409 `invalid_idempotent_request`. So:
--
-- * Every notice job sends under one stable key derived from its own id, and
--   every retry of that job — after a refusal, a lost response, or a crash —
--   calls the provider again with the same key. Whether or not the first
--   request was accepted, the provider ends up having sent exactly one email.
--
-- * `delivery_payload` freezes the rendered message (recipient, subject, HTML,
--   tags) before the first attempt, and every retry sends *that* rather than
--   re-rendering. Re-rendering would change the payload whenever a template was
--   edited or the asset's customer changed in between, and the provider would
--   refuse the key. The payload is cleared once the outcome is recorded, so a
--   rendered message stays at rest only while its delivery is unsettled.
--
-- * `delivery_attempted_at` is when that first attempt was made, which starts
--   the provider's 24-hour de-duplication window. A retry after the window
--   could no longer be de-duplicated, so the scheduler does not attempt one: the
--   job is marked `failed` with an explicit "delivery outcome unknown" reason
--   instead of guessing in either direction.
--
-- * `provider_message_id` and `delivered_at` are written only after the
--   provider has confirmed acceptance, and the next stage of the chain is
--   scheduled only after they are committed. They are the only evidence of
--   delivery the table holds.
--
-- All four are nullable with no default and no backfill. No row in any
-- environment is mid-delivery under the old model in a way these columns could
-- describe; a job that was `running` under 0012 is reclaimed by startup
-- recovery and re-attempted under this one.
--
-- Access is unchanged: 0012's table-level SELECT for the purveyor's own WP roles
-- and the Super-Admin covers the new columns, and there is still no write grant
-- for anybody. `delivery_payload` holds the purveyor's own customer's address
-- and the notice text addressed to them — data the same roles already read on
-- the customers and notices screens — and only until the delivery settles.
-- ---------------------------------------------------------------------------
ALTER TABLE public.scheduled_jobs DROP COLUMN "sent_at";--> statement-breakpoint

ALTER TABLE public.scheduled_jobs ADD COLUMN "delivery_payload" jsonb;--> statement-breakpoint

ALTER TABLE public.scheduled_jobs ADD COLUMN "delivery_attempted_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE public.scheduled_jobs ADD COLUMN "provider_message_id" text;--> statement-breakpoint

ALTER TABLE public.scheduled_jobs ADD COLUMN "delivered_at" timestamp with time zone;
