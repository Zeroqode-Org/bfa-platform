import { randomUUID } from "node:crypto";

import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `findOrCreateCustomer` against real Postgres, now that a purveyor's
 * customers may share an email (0024): which customer a test's email and name
 * resolve to, that an ambiguous shared inbox resolves to nobody, and that two
 * concurrent saves of one new customer create it once — the job the dropped
 * unique index used to do.
 *
 * Opt-in: writes real rows; runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wp = randomUUID();

let pool: pg.Pool;
let db: typeof import("@bfa-platform/db")["db"];
let findOrCreateCustomer: typeof import("./asset-sync")["findOrCreateCustomer"];
let syncCustomer: typeof import("./asset-sync")["syncCustomer"];

/** An asset occupied by `customerId`, with its open occupancy row. */
async function seedOccupiedAsset(customerId: string) {
	const id = randomUUID();
	const bin = `SI-${id.slice(0, 8)}`;
	await pool.query(
		`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, current_customer_id)
		 values ($1, $2, $3, 'RP', '1 Shared Inbox Way', $4)`,
		[id, wp, bin, customerId],
	);
	await pool.query(
		`insert into customer_assignments (bfa_asset_id, customer_id, start_date)
		 values ($1, $2, current_date)`,
		[id, customerId],
	);
	return { id, bin, currentCustomerId: customerId };
}

/** A test that kept the occupant's email and changed only the name. */
function nameOnlyChange(
	asset: { id: string; bin: string; currentCustomerId: string },
	email: string,
	name: string,
) {
	return db.transaction((tx) =>
		syncCustomer({
			executor: tx,
			asset,
			waterPurveyorId: wp,
			wizardData: { customerEmail: email, customerName: name },
			renameAllowed: true,
			reassignAllowed: false,
			actor: null,
		}),
	);
}

async function rowOf(customerId: string) {
	const { rows } = await pool.query<{ name: string }>(
		"select name from customers where id = $1",
		[customerId],
	);
	return rows[0];
}

async function occupantOf(assetId: string) {
	const { rows } = await pool.query<{ current_customer_id: string }>(
		"select current_customer_id from bfa_assets where id = $1",
		[assetId],
	);
	return rows[0]?.current_customer_id;
}

async function seedCustomer(name: string, email: string) {
	const id = randomUUID();
	await pool.query(
		`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
		 values ($1, $2, $3, $4, 'standard', 'active')`,
		[id, wp, name, email],
	);
	return id;
}

async function countWithEmail(email: string) {
	const { rows } = await pool.query<{ n: number }>(
		`select count(*)::int as n from customers
		  where water_purveyor_id = $1 and lower(btrim(email)) = $2`,
		[wp, email],
	);
	return rows[0]?.n ?? 0;
}

describeDb("findOrCreateCustomer with shared emails", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
		({ db } = await import("@bfa-platform/db"));
		({ findOrCreateCustomer, syncCustomer } = await import("./asset-sync"));

		await pool.query(
			`insert into water_purveyors (id, company_name, status)
			 values ($1, 'Shared Inbox Water', 'active')`,
			[wp],
		);
	});

	afterAll(async () => {
		if (!pool) return;
		await pool.query(
			"delete from scheduled_jobs where water_purveyor_id = $1",
			[wp],
		);
		await pool.query(
			`delete from customer_assignments
			  where bfa_asset_id in (select id from bfa_assets where water_purveyor_id = $1)`,
			[wp],
		);
		await pool.query("delete from bfa_assets where water_purveyor_id = $1", [
			wp,
		]);
		await pool.query("delete from customers where water_purveyor_id = $1", [
			wp,
		]);
		await pool.query("delete from water_purveyors where id = $1", [wp]);
		await pool.end();
	});

	it("takes the only customer on an email even under another name", async () => {
		const id = await seedCustomer("Kahala Bakery", "kahala@example.com");

		const found = await db.transaction((tx) =>
			findOrCreateCustomer(tx, wp, {
				name: "Kahala Bakery LLC",
				email: "kahala@example.com",
			}),
		);

		expect(found).toEqual({ id, status: "active", created: false });
		expect(await countWithEmail("kahala@example.com")).toBe(1);
	});

	it("picks a shared inbox's customer by name, and nobody when the name fits none", async () => {
		await seedCustomer("Store 1", "office@example.com");
		const store2 = await seedCustomer("Store 2", "office@example.com");

		const byName = await db.transaction((tx) =>
			findOrCreateCustomer(tx, wp, {
				name: "store 2",
				email: "office@example.com",
			}),
		);
		expect(byName).toEqual({ id: store2, status: "active", created: false });

		const unknown = await db.transaction((tx) =>
			findOrCreateCustomer(tx, wp, {
				name: "Store 9",
				email: "office@example.com",
			}),
		);
		expect(unknown).toBeNull();
		expect(await countWithEmail("office@example.com")).toBe(2);
	});

	it("creates a new customer once, however many saves race for it", async () => {
		const results = await Promise.all(
			[1, 2, 3].map(() =>
				db.transaction((tx) =>
					findOrCreateCustomer(tx, wp, {
						name: "Race Farm",
						email: "race.farm@example.com",
					}),
				),
			),
		);

		const ids = new Set(results.map((result) => result?.id));
		expect(ids.size).toBe(1);
		expect(results.filter((result) => result?.created)).toHaveLength(1);
		expect(await countWithEmail("race.farm@example.com")).toBe(1);
	});

	describe("a test that changes only the customer's name", () => {
		it("renames the occupant when nobody else uses the email", async () => {
			const solo = await seedCustomer("Solo Bakery", "solo@example.com");
			const asset = await seedOccupiedAsset(solo);

			const logs = await nameOnlyChange(
				asset,
				"solo@example.com",
				"Solo Bakery LLC",
			);

			expect((await rowOf(solo))?.name).toBe("Solo Bakery LLC");
			expect(logs.map((line) => line.event)).toEqual([
				"customer_updated_from_test",
			]);
		});

		it("moves the asset to the one other customer on a shared inbox with that name", async () => {
			const iolani = await seedCustomer("Iolani School", "schools@example.com");
			const punahou = await seedCustomer(
				"Punahou School",
				"schools@example.com",
			);
			const asset = await seedOccupiedAsset(iolani);

			await nameOnlyChange(asset, "schools@example.com", "punahou school");

			expect(await occupantOf(asset.id)).toBe(punahou);
			// Neither customer was renamed.
			expect((await rowOf(iolani))?.name).toBe("Iolani School");
			expect((await rowOf(punahou))?.name).toBe("Punahou School");
		});

		it("changes nothing on a shared inbox when the name is nobody's", async () => {
			const store1 = await seedCustomer("Store 1", "chain@example.com");
			await seedCustomer("Store 2", "chain@example.com");
			const asset = await seedOccupiedAsset(store1);

			const logs = await nameOnlyChange(asset, "chain@example.com", "Store 3");

			expect((await rowOf(store1))?.name).toBe("Store 1");
			expect(await occupantOf(asset.id)).toBe(store1);
			expect(logs).toEqual([
				expect.objectContaining({
					event: "customer_not_resolved_from_test",
					extra: expect.objectContaining({
						customers_on_email: 2,
						reason: "shared_email_name_unmatched",
					}),
				}),
			]);
		});
	});
});
