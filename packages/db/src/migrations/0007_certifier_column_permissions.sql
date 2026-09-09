-- ---------------------------------------------------------------------------
-- certifiers — per-role column permissions
--
-- Corrects a real defect in 0006. That migration wrote
-- `GRANT UPDATE (status) ON public.certifiers TO authenticated`, reasoning that
-- a column grant is the only mechanism able to express "a WP may update only
-- `certifiers.status`". That reasoning was right about the mechanism and wrong
-- about its reach: a grant is held by the *Postgres* role, and PostgREST gives
-- every signed-in user of this application the same one — `authenticated`.
-- Capping that role at `status` therefore capped everybody at `status`,
-- including two actors who must not be capped:
--
--   * Super-Admin, whose access to this table is full (PRD § 5), and
--   * the certifier themselves, who owns `company`, `id_number` and
--     `license_expiration_date` and must be able to maintain them.
--
-- Three actors need three different column sets on one table, and there is
-- exactly one Postgres object that can see both the old row and the new one and
-- decide per caller: a BEFORE UPDATE trigger. So the grant is widened to the
-- union of the writable business columns and the per-role narrowing moves into
-- `private.enforce_certifier_column_permissions()`.
--
-- Effective access for a WP user is unchanged by this migration. The grant they
-- hold is wider; what they can actually write is not, because the trigger
-- refuses every column but `status` for a WP role. The RLS suite asserts that
-- directly rather than leaving it to be read off the grant.
--
--   | Actor                 | May update from a client session          |
--   |-----------------------|-------------------------------------------|
--   | Super-Admin           | every business column, in every tenant     |
--   | WP Admin / SubAdmin   | `status` only, own-WP certifiers only      |
--   | WP Employee           | nothing (no UPDATE policy — read only)     |
--   | Certifier (own row)   | `company`, `id_number`,                    |
--   |                       | `license_expiration_date` — never `status` |
--   | Certifier (other row) | nothing                                    |
--   | Blocked profile       | nothing                                    |
--
-- `id`, `profile_id`, `created_at` and `updated_at` stay out of the grant for
-- everybody, Super-Admin included. They are identity and bookkeeping, not
-- business data: `profile_id` is the link to the `auth.users` account whose
-- session becomes this certifier, so a client session able to rewrite it could
-- point an existing certifier record — and the licence number that prints on a
-- results document — at a different person. `updated_at` is the trigger's.
--
-- Still no INSERT and no DELETE for anybody. A `certifiers` row is created by
-- invite redemption through the privileged connection, because it has to be
-- created together with an `auth.users` record that only the service-role
-- client can make; a row inserted through PostgREST would be a certifier
-- nobody can sign in as. Nothing in the product removes one.
-- ---------------------------------------------------------------------------

-- Additive: 0006's `GRANT UPDATE (status)` stays, and this adds the other three.
-- The effective grant is the union, which is the point — the trigger below is
-- what narrows it again, per caller.
GRANT UPDATE (
  status, company, id_number, license_expiration_date
) ON public.certifiers TO authenticated;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Per-role column enforcement.
--
-- SECURITY DEFINER and `private`-schema, the same shape as the caller-resolution
-- helpers from 0001: it reads `profiles` through `private.current_global_role()`,
-- which a caller cannot reach for anybody but themselves.
--
-- A statement with no JWT subject is left alone. That is the privileged Drizzle
-- connection the application and the migrations use, which bypasses RLS
-- entirely — for it, the tRPC procedure layer is the boundary, exactly as it is
-- for every other table in this schema. This trigger is the PostgREST-side
-- boundary and nothing else, and it says so rather than pretending to be a
-- universal invariant.
--
-- Every refusal raises `insufficient_privilege` (42501), so a client sees a
-- permission error rather than a check-constraint violation — the same class of
-- error a missing grant would have produced, which is what a caller can act on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.enforce_certifier_column_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := (SELECT auth.uid());
  actor_role public.global_role;
  touches_status boolean := NEW.status IS DISTINCT FROM OLD.status;
  touches_profile_fields boolean := (
       NEW.company                  IS DISTINCT FROM OLD.company
    OR NEW.id_number                IS DISTINCT FROM OLD.id_number
    OR NEW.license_expiration_date  IS DISTINCT FROM OLD.license_expiration_date
  );
BEGIN
  -- No JWT subject: not a client session. The privileged connection bypasses
  -- RLS too, so adding a rule here would be enforcing on one connection what
  -- the policies beside it do not enforce on the other.
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  -- Identity columns, refused ahead of any role check. They are already absent
  -- from the grant, so this is the second statement of the same rule — kept for
  -- the day somebody widens the grant without reading this far.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
    RAISE EXCEPTION 'certifiers.id and certifiers.profile_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;

  actor_role := (SELECT private.current_global_role());

  -- Full access, every column, every tenant. The row policy
  -- `certifiers_all_super_admin` has already decided they may reach this row.
  IF actor_role = 'super_admin' THEN
    RETURN NEW;
  END IF;

  -- A water purveyor owns the relationship, not the record. `status` is the
  -- one column that is theirs; name, company, licence number and expiry are the
  -- professional identity that prints on a results document, and a purveyor
  -- able to rewrite those could rewrite who signed a test.
  IF actor_role IN ('wp_admin', 'wp_sub_admin') THEN
    IF touches_profile_fields THEN
      RAISE EXCEPTION
        'A water purveyor may change only certifiers.status'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- The certifier's own record. `OLD.profile_id`, not `NEW.profile_id`: the
  -- check above already refuses a change to it, and reading the old value means
  -- this decision cannot be steered by the statement being judged.
  IF actor_role = 'certifier' AND OLD.profile_id = actor THEN
    IF touches_status THEN
      RAISE EXCEPTION
        'A certifier cannot change their own status'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- Unreachable through the policies as written — every UPDATE policy on this
  -- table matches one of the branches above. It is here so that a policy added
  -- later fails closed rather than inheriting whatever this function last
  -- happened to allow.
  RAISE EXCEPTION 'Not permitted to update this certifier'
    USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION private.enforce_certifier_column_permissions() FROM PUBLIC;--> statement-breakpoint

-- Named to sort before `set_updated_at`, which is also BEFORE UPDATE on this
-- table: Postgres fires same-timing triggers in name order, so a refused update
-- is refused before anything else has had an opinion about the row.
CREATE TRIGGER enforce_column_permissions
  BEFORE UPDATE ON public.certifiers
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_certifier_column_permissions();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The certifier's own record.
--
-- 0006 gave a certifier a self SELECT policy and deliberately no self UPDATE
-- one, on the grounds that profile editing was a separate feature. It is — the
-- screen is § 6.3 and is not built — but the *permission* belongs with the rest
-- of this table's model rather than being discovered later, and without it the
-- trigger's certifier branch would be unreachable and untestable.
--
-- The role check is what a bare `profile_id = auth.uid()` would miss:
-- `private.current_global_role()` resolves to NULL for a blocked profile and,
-- since 0006, for a blocked certifier — so blocking closes this write path too.
-- The self SELECT policy from 0006 stays keyed on `auth.uid()` alone, on
-- purpose: a blocked certifier can still read their own row and find out why
-- they cannot sign in.
-- ---------------------------------------------------------------------------
CREATE POLICY "certifiers_update_self" ON public.certifiers
  FOR UPDATE TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    AND (SELECT private.current_global_role()) = 'certifier'
  )
  WITH CHECK (
    profile_id = (SELECT auth.uid())
    AND (SELECT private.current_global_role()) = 'certifier'
  );
