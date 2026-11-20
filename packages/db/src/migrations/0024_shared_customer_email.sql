-- ---------------------------------------------------------------------------
-- customers — one email address may serve several customers
--
-- 0011 made a customer's email unique inside its purveyor. The client asked
-- for the opposite (November 2026): one parent company or property manager
-- runs several businesses under different names, and every test report and
-- notice for all of them goes to one main-office inbox. So the address is now
-- a plain contact field that any number of a purveyor's customers may share.
--
-- The unique index is replaced by a plain one on the same expression, because
-- the lookups that matched on it still run: the certifier wizard and the WP's
-- register-from-test flow find a purveyor's customers by email, and now decide
-- between several by name (`lib/customer-match.ts`). The application, not the
-- database, now keeps two concurrent saves from creating the same customer
-- twice — `findOrCreateCustomer` takes a transaction-scoped advisory lock on
-- the (purveyor, email) pair.
--
-- Repair companies keep their own rule from 0011; nothing asked to change it.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.customers_water_purveyor_id_email_key;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_water_purveyor_id_email_idx
  ON public.customers USING btree (water_purveyor_id, lower(btrim(email)));
