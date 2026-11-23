-- ---------------------------------------------------------------------------
-- customers.account_number — carry the last values over, then drop it
--
-- 0025 moved the WP account number onto the assembly and copied every
-- customer's number onto the assets they occupied. The column stayed on
-- `customers` because the release that stopped using it reached production a
-- week later (2026-11-23): in between, the previous code kept writing numbers
-- to the customer record, which the new screens never read. Two things
-- happened there, and this migration settles both before the column goes:
--
-- 1. Assets registered in that week got no number at all. Every asset with no
--    number takes its occupant's.
-- 2. A customer whose number was edited after 0025 ran had the new value on
--    the customer and the old one on its assets. The edit is the newer word,
--    so it replaces the assets' number — but only for customers changed in
--    that window, and only on assets nobody has given a number of their own
--    since this release shipped. 0025 ran at 2026-11-17 22:09 UTC; the
--    release went live at 2026-11-23 10:17 UTC.
--
-- The window is written out rather than derived: it is a fact about one
-- deploy, and a rule that guessed it from `updated_at` alone would also
-- rewrite numbers a purveyor set per BIN on the new screens.
-- ---------------------------------------------------------------------------
UPDATE public.bfa_assets AS asset
   SET account_number = btrim(customer.account_number)
  FROM public.customers AS customer
 WHERE customer.id = asset.current_customer_id
   AND customer.water_purveyor_id = asset.water_purveyor_id
   AND nullif(btrim(customer.account_number), '') IS NOT NULL
   AND (
         asset.account_number IS NULL
      OR (
              customer.updated_at > '2026-11-17 22:09:00+00'
          AND customer.updated_at < '2026-11-23 10:17:00+00'
          AND asset.updated_at < '2026-11-23 10:17:00+00'
          AND asset.account_number IS DISTINCT FROM btrim(customer.account_number)
         )
       );
--> statement-breakpoint
ALTER TABLE public.customers DROP COLUMN IF EXISTS account_number;
