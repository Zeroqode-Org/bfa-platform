-- ---------------------------------------------------------------------------
-- customers / repair_companies — one email address per water purveyor
--
-- A purveyor's customer list and its approved-repairer list each address mail
-- by email, so two rows in the same purveyor sharing an address are two records
-- of one contact: the next edit to one of them silently leaves the other stale,
-- and a notice can go to the same inbox twice. The rule is scoped to the tenant
-- on purpose — two purveyors may well have the same customer or the same
-- repair firm, and neither can see the other's list.
--
-- Enforced by the database rather than by a check before the write. A
-- "does this address exist yet?" query followed by an INSERT has a window
-- between the two in which a second clerk's request can take the address; a
-- unique index has no such window, whichever path the write arrives by — the
-- tRPC procedures, which translate the violation into an inline Email error,
-- or PostgREST under the policies in 0003 and 0005.
--
-- The key is `lower(btrim(email))`. The application already trims and
-- lowercases before storing, so for its own writes the expression changes
-- nothing; it is there so a write that did not go through that normalisation
-- (PostgREST, a script, the seed) still cannot slip a second spelling of the
-- same address past the rule.
--
-- `water_purveyor_id` leads both indexes, so each still serves the existing
-- per-tenant list lookups as a left prefix; the single-column indexes from 0000
-- are left alone rather than dropped in a migration about uniqueness.
--
-- Repair companies: email is optional, and a company reachable by phone alone
-- is a real record, so the index is partial — `WHERE email IS NOT NULL` — and
-- any number of companies in one purveyor may have no email at all.
--
-- Existing duplicates are not resolved here, and nothing is deleted or rewritten
-- to make the index build. If a purveyor already holds two rows with the same
-- address the migration stops, before creating either index, and says which
-- table needs attention; somebody who knows which record is right has to merge
-- or correct them first.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  duplicate_customers integer;
  duplicate_repair_companies integer;
BEGIN
  SELECT count(*) INTO duplicate_customers
  FROM (
    SELECT 1
    FROM public.customers
    GROUP BY water_purveyor_id, lower(btrim(email))
    HAVING count(*) > 1
  ) AS duplicates;

  SELECT count(*) INTO duplicate_repair_companies
  FROM (
    SELECT 1
    FROM public.repair_companies
    WHERE email IS NOT NULL
    GROUP BY water_purveyor_id, lower(btrim(email))
    HAVING count(*) > 1
  ) AS duplicates;

  IF duplicate_customers > 0 OR duplicate_repair_companies > 0 THEN
    RAISE EXCEPTION
      'Cannot add per-purveyor email uniqueness: % duplicate customer email group(s) and % duplicate repair company email group(s) already exist. Merge or correct those rows, then re-run this migration.',
      duplicate_customers, duplicate_repair_companies;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "customers_water_purveyor_id_email_key"
  ON public.customers USING btree (water_purveyor_id, lower(btrim(email)));--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "repair_companies_water_purveyor_id_email_key"
  ON public.repair_companies USING btree (water_purveyor_id, lower(btrim(email)))
  WHERE email IS NOT NULL;
