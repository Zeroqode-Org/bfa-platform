/**
 * Per-purveyor email uniqueness: the database rules and what a person is told.
 *
 * The rules themselves are unique indexes created in
 * `0011_tenant_email_uniqueness` — `(water_purveyor_id, lower(btrim(email)))`,
 * partial on `email IS NOT NULL` for repair companies. The index names below are
 * how a router recognises which unique violation it caught, so only that one is
 * reported at the Email field.
 *
 * Import-free on purpose, so the web app's tests can assert the exact sentence
 * without pulling a router (and its database) into the browser bundle.
 */

export const CUSTOMER_EMAIL_UNIQUE_INDEX =
	"customers_water_purveyor_id_email_key";

export const REPAIR_COMPANY_EMAIL_UNIQUE_INDEX =
	"repair_companies_water_purveyor_id_email_key";

export const CUSTOMER_EMAIL_TAKEN_MESSAGE =
	"Another customer in this water purveyor already uses this email address.";

export const REPAIR_COMPANY_EMAIL_TAKEN_MESSAGE =
	"Another repair company in this water purveyor already uses this email address.";
