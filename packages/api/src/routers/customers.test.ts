import { randomUUID } from "node:crypto";
import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import pg from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { CUSTOMER_EMAIL_TAKEN_MESSAGE } from "../lib/email-uniqueness";

/**
 * The customer procedures against real Postgres: who may call them, what they
 * can see, and — the part that matters — what happens when a caller names a
 * customer belonging to somebody else.
 *
 * Two purveyors are seeded with deliberately interchangeable customers. A leak
 * between them has to look like a leak, not like a plausible row.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary and have their own suite
 * in `packages/db/src/customers-rls.test.ts`.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wpA = randomUUID();
const wpB = randomUUID();
const ids = {
	adminA: randomUUID(),
	employeeA: randomUUID(),
	adminB: randomUUID(),
	certifier: randomUUID(),
	superAdmin: randomUUID(),
	orphanedWpAdmin: randomUUID(),
};
const customerA = randomUUID();
const customerB = randomUUID();

let pool: pg.Pool;
type CustomerRow = {
	id: string;
	name: string;
	email: string;
	accountNumber: string | null;
	address: string | null;
	rateCategory: "standard" | "agricultural";
	agRenewalDate: string | null;
	status: "active" | "suspended";
	createdAt: Date;
	updatedAt: Date;
};
type CustomerInput = {
	name: string;
	email: string;
	accountNumber?: string | null;
	address?: string | null;
	status?: "active" | "suspended";
} & (
	| { rateCategory: "standard"; agRenewalDate?: null }
	| { rateCategory: "agricultural"; agRenewalDate: string }
);

let callerFor: (profileId: string) => {
	customers: {
		listCustomers: () => Promise<CustomerRow[]>;
		createCustomer: (input: CustomerInput) => Promise<CustomerRow>;
		updateCustomer: (
			input: CustomerInput & { id: string },
		) => Promise<CustomerRow>;
	};
};

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

/** A well-formed standard customer, so a refusal can only be about tenancy. */
function standardCustomer(name: string): CustomerInput {
	return {
		name,
		email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
		rateCategory: "standard",
	};
}

describeDb("customers procedures", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const { t } = await import("../index");
		const { appRouter } = await import("./index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				// `protectedProcedure` re-resolves the profile from the database, so
				// only the auth user id matters here.
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as ReturnType<typeof callerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Customer Fixture Water Works', 'CUST-A', 'active'),
			        ($2, 'Customer Fixture Water Works', 'CUST-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string][] = [
			[ids.adminA, wpA, "wp_admin"],
			[ids.employeeA, wpA, "wp_employee"],
			[ids.adminB, wpB, "wp_admin"],
			[ids.certifier, null, "certifier"],
			[ids.superAdmin, null, "super_admin"],
			// A WP role with no purveyor on the row — the broken state `wpProcedure`
			// refuses rather than running an unscoped query for.
			[ids.orphanedWpAdmin, null, "wp_admin"],
		];

		for (const [id, wp, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'Customer Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}

		// Same name in both tenants: if one shows up in the other's list, it is
		// unmistakably the wrong row rather than a plausible one.
		await pool.query(
			`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
			 values ($1, $2, 'Shared Name Holdings', 'shared@example.com', 'standard', 'active'),
			        ($3, $4, 'Shared Name Holdings', 'shared@example.com', 'standard', 'active')`,
			[customerA, wpA, customerB, wpB],
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from customers where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB],
		]);
		await pool.end();
	});

	describe("who may call them at all", () => {
		it("refuses a certifier", async () => {
			await expect(
				callerFor(ids.certifier).customers.listCustomers(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a Super-Admin, rather than showing every tenant's customers", async () => {
			await expect(
				callerFor(ids.superAdmin).customers.listCustomers(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			await expect(
				callerFor(ids.orphanedWpAdmin).customers.listCustomers(),
			).rejects.toThrow(/no water purveyor/i);
		});

		it("lets every WP role in the tenant read the list", async () => {
			for (const reader of [ids.adminA, ids.employeeA]) {
				const rows = await callerFor(reader).customers.listCustomers();
				expect(rows.map((row) => row.id)).toEqual([customerA]);
			}
		});
	});

	describe("listCustomers", () => {
		it("shows a caller only their own purveyor's customers", async () => {
			const fromA = await callerFor(ids.adminA).customers.listCustomers();
			const fromB = await callerFor(ids.adminB).customers.listCustomers();

			expect(fromA.map((row) => row.id)).toEqual([customerA]);
			expect(fromB.map((row) => row.id)).toEqual([customerB]);
		});
	});

	describe("createCustomer", () => {
		it("files the new customer under the caller's own purveyor", async () => {
			const created = await callerFor(ids.employeeA).customers.createCustomer(
				standardCustomer("Created By Employee"),
			);

			const { rows } = await pool.query(
				"select water_purveyor_id from customers where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("ignores a water purveyor sent by the client", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer({
				...standardCustomer("Tried To Pick A Tenant"),
				// Not part of the input shape — the cast is the point: even a client
				// that sends it gets its own tenant.
				waterPurveyorId: wpB,
			} as unknown as CustomerInput);

			const { rows } = await pool.query(
				"select water_purveyor_id from customers where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("stores the renewal date for an agricultural customer", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer({
				name: "Ridgeline Orchards",
				email: "billing@ridgeline.example",
				rateCategory: "agricultural",
				agRenewalDate: "2027-03-01",
			});

			expect(created.agRenewalDate).toBe("2027-03-01");
		});

		it("emits a structured audit line naming the actor, customer and tenant", async () => {
			const lines = captureLogs();

			const created = await callerFor(ids.adminA).customers.createCustomer(
				standardCustomer("Audited Create"),
			);

			const entry = lines.find((line) => line.event === "customer_created");
			expect(entry).toMatchObject({
				event: "customer_created",
				actor_id: ids.adminA,
				customer_id: created.id,
				wp_id: wpA,
			});
			expect(typeof entry?.timestamp).toBe("string");
		});
	});

	describe("email uniqueness within a purveyor", () => {
		it("refuses a second customer with the same address, however it is spelled", async () => {
			const first = await callerFor(ids.adminA).customers.createCustomer({
				name: "Unique Email First",
				email: "unique.customer@example.com",
				rateCategory: "standard",
			});
			expect(first.email).toBe("unique.customer@example.com");

			await expect(
				callerFor(ids.employeeA).customers.createCustomer({
					name: "Unique Email Second",
					email: "  Unique.Customer@EXAMPLE.com ",
					rateCategory: "standard",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: CUSTOMER_EMAIL_TAKEN_MESSAGE,
			});

			const { rows } = await pool.query(
				`select count(*)::int as count from customers
				 where water_purveyor_id = $1 and lower(btrim(email)) = 'unique.customer@example.com'`,
				[wpA],
			);
			expect(rows[0]?.count).toBe(1);
		});

		it("allows the same address in a different purveyor", async () => {
			await callerFor(ids.adminA).customers.createCustomer({
				name: "Cross Tenant Email A",
				email: "cross.tenant.customer@example.com",
				rateCategory: "standard",
			});

			const other = await callerFor(ids.adminB).customers.createCustomer({
				name: "Cross Tenant Email B",
				email: "cross.tenant.customer@example.com",
				rateCategory: "standard",
			});

			expect(other.email).toBe("cross.tenant.customer@example.com");
		});

		it("refuses an edit onto another customer's address and leaves the row untouched", async () => {
			await callerFor(ids.adminA).customers.createCustomer({
				name: "Holds The Address",
				email: "held.customer@example.com",
				rateCategory: "standard",
			});
			const mover = await callerFor(ids.adminA).customers.createCustomer({
				name: "Wants The Address",
				email: "own.customer@example.com",
				rateCategory: "standard",
			});

			await expect(
				callerFor(ids.adminA).customers.updateCustomer({
					id: mover.id,
					name: mover.name,
					email: "HELD.customer@example.com",
					accountNumber: mover.accountNumber,
					address: mover.address,
					rateCategory: "standard",
					agRenewalDate: null,
					status: mover.status,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: CUSTOMER_EMAIL_TAKEN_MESSAGE,
			});

			const { rows } = await pool.query(
				"select email, updated_at from customers where id = $1",
				[mover.id],
			);
			expect(rows[0]?.email).toBe("own.customer@example.com");
			expect(new Date(rows[0]?.updated_at).getTime()).toBe(
				mover.updatedAt.getTime(),
			);
		});

		it("saves an edit that keeps the customer's own address", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer({
				name: "Keeps Its Address",
				email: "keeps.customer@example.com",
				rateCategory: "standard",
			});

			const renamed = await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: "Keeps Its Address, Renamed",
				// Its own address in another spelling is still its own address.
				email: " Keeps.Customer@Example.com ",
				accountNumber: created.accountNumber,
				address: created.address,
				rateCategory: "standard",
				agRenewalDate: null,
				status: created.status,
			});

			expect(renamed.name).toBe("Keeps Its Address, Renamed");
			expect(renamed.email).toBe("keeps.customer@example.com");
		});

		it("enforces the rule in the database, not only in the procedure", async () => {
			await pool.query(
				`insert into customers (water_purveyor_id, name, email, rate_category, status)
				 values ($1, 'Raw Constraint First', 'raw.customer@example.com', 'standard', 'active')`,
				[wpA],
			);

			await expect(
				pool.query(
					`insert into customers (water_purveyor_id, name, email, rate_category, status)
					 values ($1, 'Raw Constraint Second', '  RAW.Customer@example.com', 'standard', 'active')`,
					[wpA],
				),
			).rejects.toMatchObject({
				code: "23505",
				constraint: "customers_water_purveyor_id_email_key",
			});
		});

		it("lets exactly one of two concurrent creates take an address", async () => {
			const results = await Promise.allSettled(
				["Race Left", "Race Right"].map((name) =>
					callerFor(ids.adminA).customers.createCustomer({
						name,
						email: "race.customer@example.com",
						rateCategory: "standard",
					}),
				),
			);

			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const [refused] = results.filter(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			expect(refused?.reason).toMatchObject({ code: "CONFLICT" });
		});
	});

	describe("updateCustomer", () => {
		it("updates a customer in the caller's own purveyor", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer(
				standardCustomer("Before Rename"),
			);

			const updated = await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: "After Rename",
				email: created.email,
				rateCategory: "standard",
				status: "active",
			});

			expect(updated.name).toBe("After Rename");
		});

		it("refuses a customer id from the other tenant, and leaves the row untouched", async () => {
			await expect(
				callerFor(ids.adminA).customers.updateCustomer({
					id: customerB,
					name: "Taken Over",
					email: "taken.over@example.com",
					rateCategory: "standard",
					status: "suspended",
				}),
			).rejects.toThrow(/not found/i);

			const { rows } = await pool.query(
				"select name, status from customers where id = $1",
				[customerB],
			);

			// Not found, not merely refused: the other tenant's row is unchanged.
			expect(rows[0]).toMatchObject({
				name: "Shared Name Holdings",
				status: "active",
			});
		});

		it("clears a stale renewal date when a customer leaves the agricultural rate", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer({
				name: "Left The Ag Rate",
				email: "left.ag@example.com",
				rateCategory: "agricultural",
				agRenewalDate: "2027-05-15",
			});

			const updated = await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: created.name,
				email: created.email,
				rateCategory: "standard",
				status: "active",
			});

			expect(updated.agRenewalDate).toBeNull();
		});

		it("writes nothing when the save changed nothing", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer({
				...standardCustomer("Saved Without Editing"),
				accountNumber: "AC-9001",
				address: "3 Reservoir Lane",
			});

			const lines = captureLogs();

			// Opening the edit dialog and pressing save. Every field is sent on
			// every save, so the request looks exactly like a real edit.
			const returned = await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: created.name,
				email: created.email,
				accountNumber: created.accountNumber,
				address: created.address,
				rateCategory: "standard",
				status: "active",
			});

			const { rows } = await pool.query(
				"select updated_at from customers where id = $1",
				[created.id],
			);

			// The row comes back, so the client has nothing to handle differently.
			expect(returned).toMatchObject({
				id: created.id,
				name: created.name,
			});
			// But `updated_at` still means "when this row last changed"…
			expect(new Date(rows[0]?.updated_at).getTime()).toBe(
				created.updatedAt.getTime(),
			);
			// …and the audit trail carries no line for a change that never happened.
			expect(lines.some((line) => line.event === "customer_updated")).toBe(
				false,
			);
			expect(
				lines.some((line) => line.event === "customer_status_changed"),
			).toBe(false);
		});

		it("still writes when only one field moved", async () => {
			// The guard above must not swallow a real edit — a single changed
			// character is an update.
			const created = await callerFor(ids.adminA).customers.createCustomer({
				...standardCustomer("One Field Moves"),
				accountNumber: "AC-9002",
			});

			const updated = await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: created.name,
				email: created.email,
				accountNumber: "AC-9003",
				address: created.address,
				rateCategory: "standard",
				status: "active",
			});

			expect(updated.accountNumber).toBe("AC-9003");
			expect(updated.updatedAt.getTime()).not.toBe(created.updatedAt.getTime());
		});

		it("treats clearing an optional field as a real change", async () => {
			// `null` and the value it replaces are both "sent every time", so the
			// comparison has to tell them apart rather than reading both as absent.
			const created = await callerFor(ids.adminA).customers.createCustomer({
				...standardCustomer("Clears An Address"),
				address: "8 Pump House Row",
			});

			const updated = await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: created.name,
				email: created.email,
				accountNumber: created.accountNumber,
				address: null,
				rateCategory: "standard",
				status: "active",
			});

			expect(updated.address).toBeNull();
		});

		it("logs a status change on its own line, on top of the update line", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer(
				standardCustomer("Audited Suspend"),
			);

			const lines = captureLogs();

			await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: created.name,
				email: created.email,
				rateCategory: "standard",
				status: "suspended",
			});

			expect(
				lines.find((line) => line.event === "customer_status_changed"),
			).toMatchObject({
				actor_id: ids.adminA,
				customer_id: created.id,
				wp_id: wpA,
				from: "active",
				to: "suspended",
			});
			expect(lines.some((line) => line.event === "customer_updated")).toBe(
				true,
			);
		});

		it("does not log a status change when the status did not move", async () => {
			const created = await callerFor(ids.adminA).customers.createCustomer(
				standardCustomer("Audited Rename Only"),
			);

			const lines = captureLogs();

			await callerFor(ids.adminA).customers.updateCustomer({
				id: created.id,
				name: "Renamed Only",
				email: created.email,
				rateCategory: "standard",
				status: "active",
			});

			expect(
				lines.some((line) => line.event === "customer_status_changed"),
			).toBe(false);
		});
	});
});
