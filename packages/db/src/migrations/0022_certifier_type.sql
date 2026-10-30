-- ---------------------------------------------------------------------------
-- Internal and external certifiers
--
-- A purveyor inviting a certifier says whether they are its own staff
-- (internal) or a private tester it accepts reports from (external), and the
-- Certifiers screen lists the two in separate tabs (client, October 2026).
--
-- The type lives on `wp_certifier_authorizations`, not on `certifiers`: one
-- person holds one certifier row across every purveyor they work for, and may
-- be internal to one and external to another. Existing authorizations become
-- external — the common case — and the purveyor can move any of them.
--
-- `invitations.certifier_type` carries the choice from the invite to the
-- authorization redemption creates. It is nullable: other roles have no type,
-- and a certifier invitation sent before this migration redeems as external.
-- The check keeps a type off every non-certifier invitation.
--
-- Access is unchanged: both tables' grants are table-level (0017), so they
-- cover the new columns, and no policy references them. Every write goes
-- through the privileged connection behind the procedures.
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."certifier_type" AS ENUM('internal', 'external');
--> statement-breakpoint
ALTER TABLE public.wp_certifier_authorizations
  ADD COLUMN "certifier_type" "certifier_type" DEFAULT 'external' NOT NULL;
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD COLUMN "certifier_type" "certifier_type";
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "invitations_certifier_type_role"
  CHECK ("certifier_type" IS NULL OR "role" = 'certifier');
