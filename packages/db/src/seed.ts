import { resolve } from "node:path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: resolve(process.cwd(), "apps/web/.env.local") });

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const seededUserPassword = process.env.SEED_USER_PASSWORD;

if (!databaseUrl || !supabaseUrl || !serviceRoleKey || !seededUserPassword) {
	throw new Error(
		"DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SEED_USER_PASSWORD are required to seed fixtures.",
	);
}

const pool = new Pool({ connectionString: databaseUrl });

const ids = {
	wpHarbor: "10000000-0000-4000-8000-000000000001",
	wpRidge: "10000000-0000-4000-8000-000000000002",
	certifierSingle: "10000000-0000-4000-8000-000000000031",
	certifierMulti: "10000000-0000-4000-8000-000000000032",
	harborStandardCustomer: "10000000-0000-4000-8000-000000000041",
	harborAgriculturalCustomer: "10000000-0000-4000-8000-000000000042",
	ridgeStandardCustomer: "10000000-0000-4000-8000-000000000043",
	ridgeAgriculturalCustomer: "10000000-0000-4000-8000-000000000044",
	harborPastDueAsset: "10000000-0000-4000-8000-000000000051",
	harborDueSoonAsset: "10000000-0000-4000-8000-000000000052",
	harborCurrentAsset: "10000000-0000-4000-8000-000000000053",
	ridgePastDueAsset: "10000000-0000-4000-8000-000000000054",
	ridgeDueSoonAsset: "10000000-0000-4000-8000-000000000055",
	ridgeCurrentAsset: "10000000-0000-4000-8000-000000000056",
	harborReminderTemplate: "10000000-0000-4000-8000-000000000061",
	harborLateNoticeTemplate: "10000000-0000-4000-8000-000000000062",
	harborAutomatedNotices: "10000000-0000-4000-8000-000000000071",
	harborDraft: "10000000-0000-4000-8000-000000000081",
	ridgeDraft: "10000000-0000-4000-8000-000000000082",
	harborPass: "10000000-0000-4000-8000-000000000083",
	ridgeFail: "10000000-0000-4000-8000-000000000084",
	// The no-BIN flow (PRD § 7, flow 2): a submitted test carrying only what the
	// certifier typed, with no asset behind it. It is the one fixture that
	// exercises the WP's "link to asset" action, and without it the unresolved
	// half of `/wp/tests` has nothing to show in development.
	harborUnresolved: "10000000-0000-4000-8000-000000000085",
} as const;

const seedUsers = [
	{ key: "wpHarborAdmin", email: "seed.harbor.admin@bfa.local" },
	{ key: "wpHarborEmployee", email: "seed.harbor.employee@bfa.local" },
	{ key: "wpRidgeAdmin", email: "seed.ridge.admin@bfa.local" },
	{ key: "wpRidgeEmployee", email: "seed.ridge.employee@bfa.local" },
	{ key: "certifierSingleProfile", email: "seed.certifier.single@bfa.local" },
	{ key: "certifierMultiProfile", email: "seed.certifier.multi@bfa.local" },
] as const;

type SeedUserKey = (typeof seedUsers)[number]["key"];
type SeedUserIds = Record<SeedUserKey, string>;
type AuthUser = { id: string; email?: string | null };

function log(event: string, fields: Record<string, string | number | boolean>) {
	console.log(
		JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }),
	);
}

function honoluluDate(): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Pacific/Honolulu",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date());
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value;
	return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date: string, days: number): string {
	const parsed = new Date(`${date}T00:00:00.000Z`);
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
}

async function authAdmin<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${supabaseUrl}/auth/v1/admin${path}`, {
		...init,
		headers: {
			apikey: serviceRoleKey,
			authorization: `Bearer ${serviceRoleKey}`,
			"content-type": "application/json",
			...init?.headers,
		},
	});
	if (!response.ok) {
		throw new Error(
			`Supabase Auth admin request failed: ${response.status} ${await response.text()}`,
		);
	}
	return (await response.json()) as T;
}

async function findAuthUserId(email: string): Promise<string | null> {
	let page = 1;
	while (page <= 20) {
		const data = await authAdmin<{ users: AuthUser[] }>(
			`/users?page=${page}&per_page=200`,
		);
		const user = data.users.find(
			(candidate: AuthUser) => candidate.email === email,
		);
		if (user) return user.id;
		if (data.users.length < 200) return null;
		page += 1;
	}
	throw new Error(
		"Could not find a seeded Auth user within the pagination limit.",
	);
}

async function ensureAuthUsers(): Promise<SeedUserIds> {
	const result = {} as SeedUserIds;

	for (const user of seedUsers) {
		const existingUserId = await findAuthUserId(user.email);
		let userId: string;
		if (!existingUserId) {
			const data = await authAdmin<AuthUser>("/users", {
				method: "POST",
				body: JSON.stringify({
					email: user.email,
					password: seededUserPassword,
					email_confirm: true,
				}),
			});
			userId = data.id;
			log("seed_auth_user_created", { actor_id: userId, email: user.email });
		} else {
			userId = existingUserId;
			await authAdmin<AuthUser>(`/users/${userId}`, {
				method: "PUT",
				body: JSON.stringify({
					password: seededUserPassword,
					email_confirm: true,
				}),
			});
			log("seed_auth_user_reconciled", { actor_id: userId, email: user.email });
		}
		result[user.key] = userId;
	}

	return result;
}

async function seedDatabase(authUserIds: SeedUserIds) {
	const client = await pool.connect();
	const today = honoluluDate();
	const dates = {
		pastDue: addDays(today, -10),
		dueSoon: addDays(today, 20),
		current: addDays(today, 180),
		agRenewal: addDays(today, 45),
	};

	try {
		await client.query("BEGIN");

		await client.query(
			`insert into water_purveyors (id, company_name, address, pwsid, subdomain, status)
			 values ($1, $2, $3, $4, $5, 'active'), ($6, $7, $8, $9, $10, 'active')
			 on conflict (id) do update set company_name = excluded.company_name, address = excluded.address,
			 pwsid = excluded.pwsid, subdomain = excluded.subdomain, status = excluded.status`,
			[
				ids.wpHarbor,
				"Harbor Water Works",
				"100 Harbor Way, Honolulu, HI 96813",
				"HI-TEST-001",
				"seed-harbor",
				ids.wpRidge,
				"Ridge Water Works",
				"200 Ridge Road, Honolulu, HI 96814",
				"HI-TEST-002",
				"seed-ridge",
			],
		);

		const profiles = [
			[authUserIds.wpHarborAdmin, ids.wpHarbor, "Harbor Admin", "wp_admin"],
			[
				authUserIds.wpHarborEmployee,
				ids.wpHarbor,
				"Harbor Employee",
				"wp_employee",
			],
			[authUserIds.wpRidgeAdmin, ids.wpRidge, "Ridge Admin", "wp_admin"],
			[
				authUserIds.wpRidgeEmployee,
				ids.wpRidge,
				"Ridge Employee",
				"wp_employee",
			],
			[
				authUserIds.certifierSingleProfile,
				null,
				"Casey Certifier",
				"certifier",
			],
			[
				authUserIds.certifierMultiProfile,
				null,
				"Morgan Certifier",
				"certifier",
			],
		] as const;
		for (const [id, waterPurveyorId, fullName, globalRole] of profiles) {
			await client.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, $3, $4::global_role, 'active')
				 on conflict (id) do update set water_purveyor_id = excluded.water_purveyor_id,
				 full_name = excluded.full_name, global_role = excluded.global_role, status = excluded.status`,
				[id, waterPurveyorId, fullName, globalRole],
			);
		}

		await client.query(
			`insert into certifiers (id, profile_id, company, id_number, license_expiration_date, status)
			 values ($1, $2, $3, $4, $5, 'active'), ($6, $7, $8, $9, $10, 'active')
			 on conflict (id) do update set profile_id = excluded.profile_id, company = excluded.company,
			 id_number = excluded.id_number, license_expiration_date = excluded.license_expiration_date,
			 status = excluded.status`,
			[
				ids.certifierSingle,
				authUserIds.certifierSingleProfile,
				"Casey Testing LLC",
				"CERT-SEED-001",
				"2027-12-31",
				ids.certifierMulti,
				authUserIds.certifierMultiProfile,
				"Morgan Testing LLC",
				"CERT-SEED-002",
				"2028-12-31",
			],
		);

		const customers = [
			[
				ids.harborStandardCustomer,
				ids.wpHarbor,
				"H-1001",
				"Alex Morgan",
				"10 Palm Street, Honolulu, HI 96813",
				"alex.morgan@seed.example",
				"standard",
				null,
			],
			[
				ids.harborAgriculturalCustomer,
				ids.wpHarbor,
				"H-1002",
				"Taylor Lee",
				"11 Palm Street, Honolulu, HI 96813",
				"taylor.lee@seed.example",
				"agricultural",
				dates.agRenewal,
			],
			[
				ids.ridgeStandardCustomer,
				ids.wpRidge,
				"R-1001",
				"Alex Morgan",
				"10 Palm Street, Honolulu, HI 96813",
				"alex.morgan@seed.example",
				"standard",
				null,
			],
			[
				ids.ridgeAgriculturalCustomer,
				ids.wpRidge,
				"R-1002",
				"Taylor Lee",
				"11 Palm Street, Honolulu, HI 96813",
				"taylor.lee@seed.example",
				"agricultural",
				dates.agRenewal,
			],
		] as const;
		for (const customer of customers) {
			await client.query(
				`insert into customers (id, water_purveyor_id, account_number, name, address, email, rate_category, ag_renewal_date, status)
				 values ($1, $2, $3, $4, $5, $6, $7::rate_category, $8, 'active')
				 on conflict (id) do update set water_purveyor_id = excluded.water_purveyor_id,
				 account_number = excluded.account_number, name = excluded.name, address = excluded.address,
				 email = excluded.email, rate_category = excluded.rate_category,
				 ag_renewal_date = excluded.ag_renewal_date, status = excluded.status`,
				[...customer],
			);
		}

		const assets = [
			[
				ids.harborPastDueAsset,
				ids.wpHarbor,
				"SEED-BIN-100",
				ids.harborStandardCustomer,
				"RP",
				"Watts",
				"909",
				"H-PAST",
				"2 inch",
				"10 Palm Street, Honolulu, HI 96813",
				"Mechanical room",
				dates.pastDue,
				"past_due",
			],
			[
				ids.harborDueSoonAsset,
				ids.wpHarbor,
				"SEED-BIN-200",
				ids.harborAgriculturalCustomer,
				"DC",
				"Febco",
				"825Y",
				"H-SOON",
				"1 inch",
				"11 Palm Street, Honolulu, HI 96813",
				"Irrigation closet",
				dates.dueSoon,
				"due_soon",
			],
			[
				ids.harborCurrentAsset,
				ids.wpHarbor,
				"SEED-BIN-300",
				ids.harborStandardCustomer,
				"PVB",
				"Zurn",
				"975XL",
				"H-CURRENT",
				"1 inch",
				"12 Palm Street, Honolulu, HI 96813",
				"Exterior wall",
				dates.current,
				"active",
			],
			[
				ids.ridgePastDueAsset,
				ids.wpRidge,
				"SEED-BIN-100",
				ids.ridgeStandardCustomer,
				"RP",
				"Watts",
				"909",
				"R-PAST",
				"2 inch",
				"10 Palm Street, Honolulu, HI 96813",
				"Mechanical room",
				dates.pastDue,
				"past_due",
			],
			[
				ids.ridgeDueSoonAsset,
				ids.wpRidge,
				"SEED-BIN-200",
				ids.ridgeAgriculturalCustomer,
				"DC",
				"Febco",
				"825Y",
				"R-SOON",
				"1 inch",
				"11 Palm Street, Honolulu, HI 96813",
				"Irrigation closet",
				dates.dueSoon,
				"due_soon",
			],
			[
				ids.ridgeCurrentAsset,
				ids.wpRidge,
				"SEED-BIN-300",
				ids.ridgeStandardCustomer,
				"PVB",
				"Zurn",
				"975XL",
				"R-CURRENT",
				"1 inch",
				"12 Palm Street, Honolulu, HI 96813",
				"Exterior wall",
				dates.current,
				"active",
			],
		] as const;
		for (const asset of assets) {
			await client.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, current_customer_id, bfa_type, make, model, serial_number, size, service_address, assembly_location, annual_test_date, asset_status)
				 values ($1, $2, $3, $4, $5::bfa_type, $6, $7, $8, $9, $10, $11, $12, $13::asset_status)
				 on conflict (id) do update set water_purveyor_id = excluded.water_purveyor_id, bin = excluded.bin,
				 current_customer_id = excluded.current_customer_id, bfa_type = excluded.bfa_type, make = excluded.make,
				 model = excluded.model, serial_number = excluded.serial_number, size = excluded.size,
				 service_address = excluded.service_address, assembly_location = excluded.assembly_location,
				 annual_test_date = excluded.annual_test_date, asset_status = excluded.asset_status`,
				[...asset],
			);
		}

		const assignments = [
			[
				"10000000-0000-4000-8000-000000000091",
				ids.harborPastDueAsset,
				ids.harborStandardCustomer,
			],
			[
				"10000000-0000-4000-8000-000000000092",
				ids.harborDueSoonAsset,
				ids.harborAgriculturalCustomer,
			],
			[
				"10000000-0000-4000-8000-000000000093",
				ids.harborCurrentAsset,
				ids.harborStandardCustomer,
			],
			[
				"10000000-0000-4000-8000-000000000094",
				ids.ridgePastDueAsset,
				ids.ridgeStandardCustomer,
			],
			[
				"10000000-0000-4000-8000-000000000095",
				ids.ridgeDueSoonAsset,
				ids.ridgeAgriculturalCustomer,
			],
			[
				"10000000-0000-4000-8000-000000000096",
				ids.ridgeCurrentAsset,
				ids.ridgeStandardCustomer,
			],
		] as const;
		for (const [id, assetId, customerId] of assignments) {
			await client.query(
				`insert into customer_assignments (id, bfa_asset_id, customer_id, start_date, end_date)
				 values ($1, $2, $3, $4, null)
				 on conflict (id) do update set bfa_asset_id = excluded.bfa_asset_id,
				 customer_id = excluded.customer_id, start_date = excluded.start_date, end_date = null`,
				[id, assetId, customerId, addDays(today, -365)],
			);
		}

		const authorizations = [
			[
				"10000000-0000-4000-8000-000000000101",
				ids.certifierSingle,
				ids.wpHarbor,
			],
			[
				"10000000-0000-4000-8000-000000000102",
				ids.certifierMulti,
				ids.wpHarbor,
			],
			["10000000-0000-4000-8000-000000000103", ids.certifierMulti, ids.wpRidge],
		] as const;
		for (const [id, certifierId, waterPurveyorId] of authorizations) {
			await client.query(
				`insert into wp_certifier_authorizations (id, certifier_id, water_purveyor_id, authorization_status)
				 values ($1, $2, $3, 'active')
				 on conflict (certifier_id, water_purveyor_id) do update set authorization_status = 'active'`,
				[id, certifierId, waterPurveyorId],
			);
		}

		// Named fields rather than a positional tuple: two of these columns are
		// jsonb and have to be stringified while the rest are passed through, and
		// a row whose shape is read by counting commas is one a later column will
		// be inserted into the middle of.
		const submissions = [
			{
				id: ids.harborDraft,
				bfaAssetId: ids.harborPastDueAsset,
				certifierId: ids.certifierSingle,
				waterPurveyorId: ids.wpHarbor,
				status: "draft",
				bfaType: "RP",
				wizardData: {
					fixtureKey: "harbor-draft",
					notes: "Draft at assembly details",
				},
				overriddenFields: null,
				submittedBinText: null,
				testDate: null,
				testResult: null,
				currentStep: 1,
			},
			{
				id: ids.ridgeDraft,
				bfaAssetId: ids.ridgeDueSoonAsset,
				certifierId: ids.certifierMulti,
				waterPurveyorId: ids.wpRidge,
				status: "draft",
				bfaType: "DC",
				wizardData: { fixtureKey: "ridge-draft", notes: "Draft at test block" },
				overriddenFields: null,
				submittedBinText: null,
				testDate: null,
				testResult: null,
				currentStep: 4,
			},
			{
				id: ids.harborPass,
				bfaAssetId: ids.harborCurrentAsset,
				certifierId: ids.certifierSingle,
				waterPurveyorId: ids.wpHarbor,
				status: "submitted",
				bfaType: "PVB",
				wizardData: {
					fixtureKey: "harbor-pass",
					customerName: "Alex Morgan",
					assemblyLocation: "Roof plant room",
				},
				// The existing-BIN flow prefilled the assembly location from the
				// asset's prior test and the certifier typed over it. § 6.6.6 asks
				// for that to be visibly flagged to the WP rather than silently
				// replaced, so one fixture carries the marker.
				overriddenFields: ["assemblyLocation"],
				submittedBinText: null,
				testDate: addDays(today, -30),
				testResult: "pass",
				currentStep: 6,
			},
			{
				id: ids.ridgeFail,
				bfaAssetId: ids.ridgePastDueAsset,
				certifierId: ids.certifierMulti,
				waterPurveyorId: ids.wpRidge,
				status: "submitted",
				bfaType: "RP",
				wizardData: { fixtureKey: "ridge-fail", customerName: "Alex Morgan" },
				overriddenFields: null,
				submittedBinText: null,
				testDate: addDays(today, -5),
				testResult: "fail",
				currentStep: 6,
			},
			{
				id: ids.harborUnresolved,
				// No asset, which is the point of the fixture: the certifier left the
				// BIN blank, so working out which assembly this belongs to is the
				// purveyor's job (PRD § 7, flow 2).
				bfaAssetId: null,
				certifierId: ids.certifierSingle,
				waterPurveyorId: ids.wpHarbor,
				status: "submitted",
				bfaType: "DC",
				wizardData: {
					fixtureKey: "harbor-unresolved",
					customerName: "Priya Raman",
					assemblyLocation: "Basement, behind the meter",
				},
				overriddenFields: null,
				submittedBinText: "HRB-?? 0142",
				testDate: addDays(today, -12),
				testResult: "pass",
				currentStep: 6,
			},
		] as const;
		for (const submission of submissions) {
			await client.query(
				`insert into test_submissions (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type, wizard_data, overridden_fields, submitted_bin_text, test_date, test_result, current_step)
				 values ($1, $2, $3, $4, $5::submission_status, $6::bfa_type, $7::jsonb, $8::jsonb, $9, $10, $11::test_result, $12)
				 on conflict (id) do update set bfa_asset_id = excluded.bfa_asset_id, certifier_id = excluded.certifier_id,
				 water_purveyor_id = excluded.water_purveyor_id, status = excluded.status, bfa_type = excluded.bfa_type,
				 wizard_data = excluded.wizard_data, overridden_fields = excluded.overridden_fields,
				 submitted_bin_text = excluded.submitted_bin_text,
				 test_date = excluded.test_date, test_result = excluded.test_result, current_step = excluded.current_step`,
				[
					submission.id,
					submission.bfaAssetId,
					submission.certifierId,
					submission.waterPurveyorId,
					submission.status,
					submission.bfaType,
					JSON.stringify(submission.wizardData),
					submission.overriddenFields
						? JSON.stringify(submission.overriddenFields)
						: null,
					submission.submittedBinText,
					submission.testDate,
					submission.testResult,
					submission.currentStep,
				],
			);
		}

		await client.query(
			`insert into notice_templates (id, water_purveyor_id, notice_type, subject, body, is_enabled)
			 values ($1, $2, 'reminder', $3, $4, true), ($5, $2, 'late_notice_1', $6, $7, true)
			 on conflict (water_purveyor_id, notice_type) do update set subject = excluded.subject,
			 body = excluded.body, is_enabled = excluded.is_enabled`,
			[
				ids.harborReminderTemplate,
				ids.wpHarbor,
				"Harbor annual test reminder",
				"Hello {{customer_name}}, your {{bfa_type}} at {{service_address}} is due on {{due_date}}.",
				ids.harborLateNoticeTemplate,
				"Harbor late notice",
				"Your assembly with BIN {{bin}} is overdue.",
			],
		);

		await client.query(
			`insert into wp_feature_flags (id, water_purveyor_id, feature, is_enabled, updated_by_profile_id)
			 values ($1, $2, 'automated_notices', true, $3)
			 on conflict (water_purveyor_id, feature) do update set is_enabled = true,
			 updated_by_profile_id = excluded.updated_by_profile_id`,
			[ids.harborAutomatedNotices, ids.wpHarbor, authUserIds.wpHarborAdmin],
		);

		await client.query("COMMIT");
		log("seed_database_reconciled", {
			water_purveyor_count: 2,
			asset_count: 6,
			submission_count: 5,
		});
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function main() {
	const authUserIds = await ensureAuthUsers();
	await seedDatabase(authUserIds);

	console.log("\nSeeded login credentials:");
	for (const user of seedUsers) console.log(`  ${user.email}`);
	console.log("  Password: the value supplied in SEED_USER_PASSWORD\n");
}

main()
	.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
