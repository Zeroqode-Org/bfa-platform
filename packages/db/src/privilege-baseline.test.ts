import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DB_TESTS_ENABLED, requireDatabaseUrl } from "./testing/db-tests";

/**
 * Pins the privilege baseline `0017_explicit_privilege_baseline` declares, so
 * it can never again drift silently.
 *
 * The behavioural RLS suites prove what each role can *do*; this one proves
 * the catalog says exactly what the migrations say and nothing more. The
 * distinction matters because of how the original drift stayed hidden: the
 * development database carried a privilege baseline that no migration
 * expressed (the API roles' default DML had been stripped outside history),
 * so every "permission denied" assertion passed there while a clean clone
 * from migrations would have disagreed. A suite that reads the catalog and
 * compares it to a literal fails on *any* database whose grants differ from
 * the migrations' intent — a stray grant from a dashboard session, a feature
 * branch applied and abandoned, or a platform default nobody revoked.
 *
 * Three literals below restate the migrations' grant surface (0001, 0003,
 * 0004, 0005, 0006+0007, 0008+0012, 0010, 0013, 0014, swept into one
 * statement by 0017). That is deliberate: the test is the check on the
 * migration's own restatement, so it must not be derived from the same file.
 * Adding a grant in a future migration means adding it here too — which is
 * the point, a grant is a decision and this is where it is recorded as one.
 *
 * Opt-in like every database-backed suite: runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

/** Every application table 0000 created. RLS and the baseline cover each. */
const APP_TABLES = [
	"bfa_assets",
	"certifiers",
	"customer_assignments",
	"customers",
	"invitations",
	"notice_templates",
	"profiles",
	"repair_companies",
	"scheduled_jobs",
	"test_submissions",
	"water_purveyors",
	"wp_certifier_authorizations",
	"wp_feature_flags",
] as const;

/**
 * Table-level grants for `authenticated`, exactly. A table absent from this
 * map must hold no table-level grant at all; `anon` and `service_role` must
 * hold none anywhere.
 */
const TABLE_GRANTS: Record<string, string[]> = {
	bfa_assets: ["SELECT"],
	certifiers: ["SELECT"],
	customer_assignments: ["SELECT"],
	customers: ["INSERT", "SELECT", "UPDATE"],
	invitations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
	notice_templates: ["SELECT"],
	profiles: ["SELECT"],
	repair_companies: ["SELECT"],
	scheduled_jobs: ["SELECT"],
	test_submissions: ["DELETE", "SELECT"],
	water_purveyors: [],
	wp_certifier_authorizations: ["SELECT"],
	wp_feature_flags: [],
};

/**
 * Column-scoped grants for `authenticated` — the explicit column ACLs only,
 * never the expansion of a table-level grant. Keyed `table.PRIVILEGE`, each
 * value sorted.
 */
const COLUMN_GRANTS: Record<string, string[]> = {
	"profiles.UPDATE": ["full_name"],
	"bfa_assets.INSERT": [
		"annual_test_date",
		"assembly_location",
		"bfa_type",
		"bin",
		"current_customer_id",
		"make",
		"model",
		"serial_number",
		"service_address",
		"size",
		"water_purveyor_id",
	],
	"bfa_assets.UPDATE": [
		"annual_test_date",
		"assembly_location",
		"bfa_type",
		"bin",
		"current_customer_id",
		"make",
		"model",
		"serial_number",
		"service_address",
		"size",
	],
	"customer_assignments.INSERT": [
		"bfa_asset_id",
		"customer_id",
		"end_date",
		"start_date",
	],
	"customer_assignments.UPDATE": ["end_date"],
	"repair_companies.INSERT": [
		"company_name",
		"email",
		"phone",
		"status",
		"water_purveyor_id",
	],
	"repair_companies.UPDATE": ["company_name", "email", "phone", "status"],
	"certifiers.UPDATE": [
		"company",
		"id_number",
		"license_expiration_date",
		"status",
	],
	"test_submissions.UPDATE": [
		"bfa_asset_id",
		"bfa_type",
		"current_step",
		"overridden_fields",
		"signature_data",
		"signature_method",
		"submitted_bin_text",
		"test_date",
		"test_result",
		"wizard_data",
	],
	"notice_templates.INSERT": [
		"body",
		"notice_type",
		"subject",
		"water_purveyor_id",
	],
	"notice_templates.UPDATE": ["body", "subject"],
};

/**
 * The policy inventory on the most access-sensitive table, by name, command
 * and kind. Behaviour is covered in `test-submissions-rls.test.ts`; this
 * catches a policy that exists without a migration behind it — which is
 * precisely the shape the suspected drift had.
 */
const TEST_SUBMISSION_POLICIES = [
	["test_submissions_all_super_admin", "ALL", "PERMISSIVE"],
	["test_submissions_delete_draft_only", "DELETE", "RESTRICTIVE"],
	["test_submissions_delete_own_draft_certifier", "DELETE", "PERMISSIVE"],
	["test_submissions_select_own_certifier", "SELECT", "PERMISSIVE"],
	["test_submissions_select_own_wp", "SELECT", "PERMISSIVE"],
	["test_submissions_update_own_draft_certifier", "UPDATE", "PERMISSIVE"],
	["test_submissions_update_own_wp", "UPDATE", "PERMISSIVE"],
] as const;

let pool: pg.Pool;

describeDb("privilege baseline (0017)", () => {
	beforeAll(() => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
	});

	afterAll(async () => {
		await pool?.end();
	});

	it("gives anon and service_role no table-level privilege on any app table", async () => {
		const { rows } = await pool.query<{
			table_name: string;
			grantee: string;
			privilege_type: string;
		}>(
			`select table_name, grantee, privilege_type
			   from information_schema.role_table_grants
			  where table_schema = 'public'
			    and table_name = any($1)
			    and grantee in ('anon', 'service_role')`,
			[[...APP_TABLES]],
		);

		expect(rows).toEqual([]);
	});

	it("grants authenticated exactly the table-level surface the migrations state", async () => {
		const { rows } = await pool.query<{
			table_name: string;
			privs: string[];
		}>(
			`select table_name, array_agg(privilege_type order by privilege_type)::text[] as privs
			   from information_schema.role_table_grants
			  where table_schema = 'public'
			    and table_name = any($1)
			    and grantee = 'authenticated'
			  group by table_name`,
			[[...APP_TABLES]],
		);

		const actual = Object.fromEntries(
			rows.map((row) => [row.table_name, row.privs]),
		);

		for (const table of APP_TABLES) {
			expect({ table, privs: actual[table] ?? [] }).toEqual({
				table,
				privs: TABLE_GRANTS[table],
			});
		}
	});

	it("grants authenticated exactly the column-scoped surface the migrations state", async () => {
		// `aclexplode(attacl)` reads the explicit column ACLs and nothing else —
		// unlike `information_schema.column_privileges`, which also expands
		// table-level grants across every column and would make this assertion
		// depend on the current column list of every table.
		const { rows } = await pool.query<{
			key: string;
			grantee: string;
			columns: string[];
		}>(
			`select c.relname || '.' || x.privilege_type as key,
			        x.grantee::regrole::text as grantee,
			        array_agg(a.attname order by a.attname)::text[] as columns
			   from pg_class c
			   join pg_attribute a
			     on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
			  cross join lateral aclexplode(a.attacl) x
			  where c.relnamespace = 'public'::regnamespace
			    and c.relname = any($1)
			  group by 1, 2
			  order by 1, 2`,
			[[...APP_TABLES]],
		);

		const foreign = rows.filter((row) => row.grantee !== "authenticated");
		expect(foreign).toEqual([]);

		const actual = Object.fromEntries(
			rows.map((row) => [row.key, row.columns]),
		);

		expect(actual).toEqual(COLUMN_GRANTS);
	});

	it("keeps future tables clean: the public default ACL names no API role", async () => {
		const { rows } = await pool.query<{ acl: string }>(
			`select defaclacl::text as acl
			   from pg_default_acl
			  where defaclrole = 'postgres'::regrole
			    and defaclnamespace = 'public'::regnamespace
			    and defaclobjtype = 'r'`,
		);

		// Either no entry at all (nothing was ever altered, nothing is granted)
		// or an entry that names none of the three API roles.
		for (const row of rows) {
			expect(row.acl).not.toMatch(/anon|authenticated|service_role/);
		}
	});

	it("has row-level security enabled on every app table", async () => {
		const { rows } = await pool.query<{ relname: string }>(
			`select relname
			   from pg_class
			  where relnamespace = 'public'::regnamespace
			    and relname = any($1)
			    and not relrowsecurity`,
			[[...APP_TABLES]],
		);

		expect(rows).toEqual([]);
	});

	it("carries exactly the test_submissions policies the migrations declare", async () => {
		const { rows } = await pool.query<{
			policyname: string;
			cmd: string;
			permissive: string;
		}>(
			`select policyname, cmd, permissive
			   from pg_policies
			  where schemaname = 'public' and tablename = 'test_submissions'
			  order by policyname`,
		);

		expect(
			rows.map((row) => [row.policyname, row.cmd, row.permissive]),
		).toEqual(TEST_SUBMISSION_POLICIES.map((row) => [...row]));
	});
});
