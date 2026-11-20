-- ---------------------------------------------------------------------------
-- bfa_assets.account_number — the water purveyor's account number, per BIN
--
-- The WP customer account number lived on `customers`, one per customer. The
-- client asked for it on the assembly instead (November 2026): one customer
-- often holds several utility accounts and meters at different locations with
-- the same purveyor, and one number on the parent record either overwrote the
-- others or blocked them. Each BIN now carries its own.
--
-- Existing numbers are copied onto every asset their customer currently
-- occupies, so nothing the purveyors typed is lost and each BIN starts with
-- the number it showed before. `customers.account_number` is left in place
-- for now: the application stops reading and writing it with this release,
-- and a later migration copies anything written to it in between onto the
-- assets and then drops it.
--
-- A WP-owned detail of the assembly like make or serial, so the purveyor's
-- column grants from 0017 are extended to it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.bfa_assets ADD COLUMN IF NOT EXISTS account_number text;
--> statement-breakpoint
UPDATE public.bfa_assets AS asset
   SET account_number = btrim(customer.account_number)
  FROM public.customers AS customer
 WHERE customer.id = asset.current_customer_id
   AND customer.water_purveyor_id = asset.water_purveyor_id
   AND asset.account_number IS NULL
   AND nullif(btrim(customer.account_number), '') IS NOT NULL;
--> statement-breakpoint
GRANT INSERT (account_number) ON public.bfa_assets TO authenticated;
--> statement-breakpoint
GRANT UPDATE (account_number) ON public.bfa_assets TO authenticated;
