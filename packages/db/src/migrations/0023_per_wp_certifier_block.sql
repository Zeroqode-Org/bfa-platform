-- ---------------------------------------------------------------------------
-- Per-purveyor certifier blocks
--
-- A purveyor blocking a certifier used to write `certifiers.status`, the
-- account-wide switch the login gate reads, so one purveyor's block took the
-- certifier off the platform for every other purveyor too. The client wants
-- the block to end only that purveyor's relationship (November 2026), so
-- `certifiers.setCertifierStatus` now revokes the purveyor's own
-- `wp_certifier_authorizations` row instead, and leaves the account alone.
--
-- Existing blocks cannot be traced to the purveyor that set them — only the
-- audit log knows — so each one is carried over conservatively: every active
-- authorization the blocked certifier holds is revoked, and the account switch
-- is cleared. No purveyor that saw the certifier as blocked sees them as
-- active afterwards; each can now unblock for itself.
--
-- Runs as the migration owner, so the `certifiers` column trigger from 0007
-- (which judges PostgREST callers) passes it through. Access is unchanged.
-- ---------------------------------------------------------------------------
UPDATE public.wp_certifier_authorizations AS auth
   SET authorization_status = 'revoked'
  FROM public.certifiers AS certifier
 WHERE certifier.id = auth.certifier_id
   AND certifier.status = 'blocked'
   AND auth.authorization_status = 'active';
--> statement-breakpoint
UPDATE public.certifiers
   SET status = 'active'
 WHERE status = 'blocked';
