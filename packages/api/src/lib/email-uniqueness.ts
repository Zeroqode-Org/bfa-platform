/**
 * Per-purveyor email uniqueness for repair companies: the database rule and
 * what a person is told.
 *
 * The rule is the unique index created in `0011_tenant_email_uniqueness` —
 * `(water_purveyor_id, lower(btrim(email)))`, partial on `email IS NOT NULL`.
 * The index name is how the router recognises the violation it caught, so only
 * that one is reported at the Email field. Customers had the same rule until
 * 0024: several customers may now share one address.
 *
 * Import-free on purpose, so the web app's tests can assert the exact sentence
 * without pulling a router (and its database) into the browser bundle.
 */

export const REPAIR_COMPANY_EMAIL_UNIQUE_INDEX =
	"repair_companies_water_purveyor_id_email_key";

export const REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE =
	"Another repair company in this water purveyor already uses this email address.";
