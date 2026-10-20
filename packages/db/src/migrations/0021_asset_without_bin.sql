-- ---------------------------------------------------------------------------
-- `bfa_assets.bin` becomes optional — the no-BIN asset
--
-- The simplified BIN wizard (client, October 2026): a certifier whose BIN is
-- blank or not found in the register no longer files an unlinked test. The
-- submit registers a fresh asset from what was typed, with no BIN, and links
-- the test to it. The purveyor assigns the BIN later from the dashboard's
-- No-BIN table — or, when the assembly turns out to be one already
-- registered, links the test there and the empty asset is deleted.
--
-- The existing `(water_purveyor_id, bin)` unique constraint stays as it is:
-- Postgres treats NULLs as distinct, so any number of BIN-less assets may
-- coexist while a real BIN is still unique per purveyor.
--
-- Blank is NULL, never an empty string: an `''` BIN would be unique, would
-- look assigned to every `is not null` check, and would print as nothing.
--
-- The partial index serves the dashboard's No-BIN card and table, which ask
-- "this purveyor's assets with no BIN" — a small slice of a large table.
--
-- Access is unchanged: no policy references `bin`, and the column grants
-- restated in 0017 cover it whether it is nullable or not.
-- ---------------------------------------------------------------------------
ALTER TABLE public.bfa_assets
  ALTER COLUMN "bin" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.bfa_assets
  ADD CONSTRAINT "bfa_assets_bin_not_blank" CHECK ("bin" IS NULL OR btrim("bin") <> '');
--> statement-breakpoint
CREATE INDEX "bfa_assets_wp_no_bin_idx"
  ON public.bfa_assets ("water_purveyor_id")
  WHERE "bin" IS NULL;
