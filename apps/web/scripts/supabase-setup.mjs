// Idempotent Supabase project setup: private Storage buckets, and (optionally)
// one throwaway Super-Admin auth user for local verification.
//
//   node --env-file=.env.local scripts/supabase-setup.mjs
//   node --env-file=.env.local scripts/supabase-setup.mjs --with-test-user
//
// Safe to run repeatedly. Requires NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY in the environment; --with-test-user also needs
// DATABASE_URL (--env-file=.env.local supplies all three).

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
	console.error(
		"Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
			"Run with: node --env-file=.env.local scripts/supabase-setup.mjs",
	);
	process.exit(1);
}

const withTestUser =
	process.argv.includes("--with-test-user") || !!process.env.SEED_TEST_USER;

const supabase = createClient(url, serviceRoleKey, {
	auth: { persistSession: false, autoRefreshToken: false },
});

const log = (fields) =>
	console.log(
		JSON.stringify({ ...fields, timestamp: new Date().toISOString() }),
	);

const BUCKETS = ["test-photos", "result-documents"];

const TEST_USER = {
	email: "dev-superadmin@bfa.local",
	password: "dev-superadmin-pw-2026",
	fullName: "Dev Super Admin",
};

async function ensureBucket(name) {
	const { error } = await supabase.storage.createBucket(name, {
		public: false,
	});
	if (error && !/already exists/i.test(error.message)) {
		throw new Error(`createBucket(${name}): ${error.message}`);
	}
	log({
		event: "storage_bucket_ensured",
		bucket: name,
		created: !error,
	});
}

async function ensureTestUser() {
	const { data: created, error: createErr } =
		await supabase.auth.admin.createUser({
			email: TEST_USER.email,
			password: TEST_USER.password,
			email_confirm: true,
		});

	let userId = created?.user?.id;

	if (createErr) {
		if (!/already been registered|already exists/i.test(createErr.message)) {
			throw new Error(`createUser: ${createErr.message}`);
		}
		// Already there — look the id up by paging the user list.
		const { data: list, error: listErr } = await supabase.auth.admin.listUsers({
			perPage: 200,
		});
		if (listErr) throw new Error(`listUsers: ${listErr.message}`);
		userId = list.users.find((u) => u.email === TEST_USER.email)?.id;
	}

	if (!userId) throw new Error("could not resolve test user id");

	// `profiles` is not exposed to the Data API (new tables are not auto-exposed),
	// so write it over a direct Postgres connection, same as `resolveCaller`.
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("--with-test-user needs DATABASE_URL in the environment");
	}
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await client.query(
			`INSERT INTO profiles (id, full_name, global_role, water_purveyor_id, status)
			 VALUES ($1, $2, 'super_admin', NULL, 'active')
			 ON CONFLICT (id) DO UPDATE
			   SET full_name = EXCLUDED.full_name,
			       global_role = EXCLUDED.global_role,
			       water_purveyor_id = EXCLUDED.water_purveyor_id,
			       status = EXCLUDED.status,
			       updated_at = now()`,
			[userId, TEST_USER.fullName],
		);
	} finally {
		await client.end();
	}

	log({ event: "test_user_ensured", actor_id: userId, role: "super_admin" });
	console.log(
		`\nTest login:\n  email:    ${TEST_USER.email}\n  password: ${TEST_USER.password}\n`,
	);
}

async function main() {
	for (const name of BUCKETS) {
		await ensureBucket(name);
	}
	if (withTestUser) {
		await ensureTestUser();
	}
	console.log("Supabase setup complete.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
