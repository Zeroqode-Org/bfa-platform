import { randomUUID } from "node:crypto";
import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import type { inferProcedureInput, inferProcedureOutput } from "@trpc/server";
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

import type { AppRouter } from "./index";

/**
 * The asset procedures against real Postgres: who may call them, what they can
 * see, and — the part that matters — what happens when a caller names an asset
 * or a customer belonging to somebody else.
 *
 * Two purveyors are seeded with deliberately interchangeable assets: the same
 * BIN, the same service address, in both tenants. A leak between them has to
 * look like a leak, not like a plausible row. The shared BIN also proves the
 * uniqueness rule is per purveyor rather than platform-wide.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary and have their own suite
 * in `packages/db/src/bfa-assets-rls.test.ts`.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

/**
 * The procedures' own input and output types, taken one at a time rather than
 * through `inferRouterInputs`/`inferRouterOutputs`.
 *
 * Those two describe what travels over HTTP, where a `timestamp` column has
 * already been JSON-serialised to a string. A `createCaller` caller returns
 * what the procedure returned — `Date` objects and all — so the router-level
 * helpers would describe a shape these tests never see.
 */
type Assets = AppRouter["assets"];
type Inputs = {
	[Procedure in keyof Assets]: inferProcedureInput<Assets[Procedure]>;
};
type Outputs = {
	[Procedure in keyof Assets]: inferProcedureOutput<Assets[Procedure]>;
};

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
const assetA = randomUUID();
const assetB = randomUUID();
const customerA = randomUUID();
const customerA2 = randomUUID();
const suspendedCustomerA = randomUUID();
const customerB = randomUUID();

let pool: pg.Pool;

let callerFor: (profileId: string) => {
	assets: {
		listAssets: (
			input?: Inputs["listAssets"],
		) => Promise<Outputs["listAssets"]>;
		getAsset: (input: Inputs["getAsset"]) => Promise<Outputs["getAsset"]>;
		createAsset: (
			input: Inputs["createAsset"],
		) => Promise<Outputs["createAsset"]>;
		updateAsset: (
			input: Inputs["updateAsset"],
		) => Promise<Outputs["updateAsset"]>;
		assignCustomer: (
			input: Inputs["assignCustomer"],
		) => Promise<Outputs["assignCustomer"]>;
	};
};

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

/** A well-formed asset, so a refusal can only be about tenancy. */
function newAsset(bin: string, overrides: Partial<Inputs["createAsset"]> = {}) {
	return {
		bin,
		bfaType: "RP" as const,
		serviceAddress: "18 Canal Road",
		annualTestDate: "2027-04-01",
		...overrides,
	};
}

/** The whole record, as the edit form sends it. */
function asUpdate(
	asset: Outputs["createAsset"],
	overrides: Partial<Inputs["updateAsset"]> = {},
) {
	return {
		id: asset.id,
		bin: asset.bin,
		bfaType: asset.bfaType,
		serviceAddress: asset.serviceAddress,
		make: asset.make,
		model: asset.model,
		serialNumber: asset.serialNumber,
		size: asset.size,
		assemblyLocation: asset.assemblyLocation,
		annualTestDate: asset.annualTestDate as string,
		...overrides,
	};
}

describeDb("asset procedures", () => {
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
			 values ($1, 'Asset Fixture Water Works', 'ASSET-A', 'active'),
			        ($2, 'Asset Fixture Water Works', 'ASSET-B', 'active')`,
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
				 values ($1, $2, 'Asset Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}

		await pool.query(
			`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
			 values ($1, $2, 'Marta Ellison', 'marta@example.com', 'standard', 'active'),
			        ($3, $4, 'Tomas Reyes', 'tomas@example.com', 'standard', 'active'),
			        ($5, $6, 'Halted Holdings', 'halted@example.com', 'standard', 'suspended'),
			        ($7, $8, 'Marta Ellison', 'marta@example.com', 'standard', 'active')`,
			[
				customerA,
				wpA,
				customerA2,
				wpA,
				suspendedCustomerA,
				wpA,
				customerB,
				wpB,
			],
		);

		// Same BIN and same address in both tenants: if one shows up in the other's
		// list it is unmistakably the wrong row, and the pair also proves the BIN
		// uniqueness constraint is scoped to a purveyor.
		await pool.query(
			`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date, asset_status)
			 values ($1, $2, 'SHARED-BIN', 'RP', '1 Shared Way', '2027-01-15', 'past_due'),
			        ($3, $4, 'SHARED-BIN', 'RP', '1 Shared Way', '2027-01-15', 'past_due')`,
			[assetA, wpA, assetB, wpB],
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			`delete from customer_assignments
			 where bfa_asset_id in (select id from bfa_assets where water_purveyor_id = any($1::uuid[]))`,
			[[wpA, wpB]],
		);
		await pool.query(
			"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
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
				callerFor(ids.certifier).assets.listAssets(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a Super-Admin, rather than showing every tenant's assets", async () => {
			await expect(
				callerFor(ids.superAdmin).assets.listAssets(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			await expect(
				callerFor(ids.orphanedWpAdmin).assets.listAssets(),
			).rejects.toThrow(/no water purveyor/i);
		});
	});

	describe("listAssets", () => {
		it("shows two purveyors completely separate lists", async () => {
			const fromA = await callerFor(ids.adminA).assets.listAssets({
				page: 1,
				pageSize: 100,
			});
			const fromB = await callerFor(ids.adminB).assets.listAssets({
				page: 1,
				pageSize: 100,
			});

			const idsFromA = fromA.rows.map((row) => row.id);
			const idsFromB = fromB.rows.map((row) => row.id);

			expect(idsFromA).toContain(assetA);
			expect(idsFromA).not.toContain(assetB);
			expect(idsFromB).toContain(assetB);
			expect(idsFromB).not.toContain(assetA);
		});

		it("counts only the caller's own tenant", async () => {
			const { total } = await callerFor(ids.adminB).assets.listAssets({
				page: 1,
				pageSize: 100,
			});

			const { rows } = await pool.query(
				"select count(*)::int as value from bfa_assets where water_purveyor_id = $1",
				[wpB],
			);

			expect(total).toBe(rows[0]?.value);
		});

		it("filters by status", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("STATUS-FILTER"),
			);

			// The status is the scheduler's, so the fixture sets it the way the
			// scheduler will — directly, not through a procedure.
			await pool.query(
				"update bfa_assets set asset_status = 'due_soon' where id = $1",
				[created.id],
			);

			const dueSoon = await callerFor(ids.adminA).assets.listAssets({
				page: 1,
				pageSize: 100,
				status: "due_soon",
			});

			expect(dueSoon.rows.map((row) => row.id)).toEqual([created.id]);
		});

		it("searches by BIN", async () => {
			await callerFor(ids.adminA).assets.createAsset(
				newAsset("FINDME-0042", { serviceAddress: "9 Elsewhere Street" }),
			);

			const found = await callerFor(ids.adminA).assets.listAssets({
				page: 1,
				pageSize: 100,
				// Lower case, partial: a BIN somebody half-remembers still finds it.
				search: "findme-00",
			});

			expect(found.rows.map((row) => row.bin)).toEqual(["FINDME-0042"]);
		});

		it("searches by service address", async () => {
			await callerFor(ids.adminA).assets.createAsset(
				newAsset("ADDRESS-SEARCH", {
					serviceAddress: "77 Waterworks Terrace",
				}),
			);

			const found = await callerFor(ids.adminA).assets.listAssets({
				page: 1,
				pageSize: 100,
				search: "waterworks terrace",
			});

			expect(found.rows.map((row) => row.bin)).toEqual(["ADDRESS-SEARCH"]);
		});

		it("never reaches the other tenant through the search", async () => {
			const found = await callerFor(ids.adminB).assets.listAssets({
				page: 1,
				pageSize: 100,
				search: "SHARED-BIN",
			});

			expect(found.rows.map((row) => row.id)).toEqual([assetB]);
		});

		it("pages, reporting the whole filtered size rather than the page's", async () => {
			for (const suffix of ["A", "B", "C"]) {
				await callerFor(ids.adminA).assets.createAsset(
					newAsset(`PAGED-${suffix}`, {
						serviceAddress: "5 Pager Lane",
					}),
				);
			}

			const first = await callerFor(ids.adminA).assets.listAssets({
				page: 1,
				pageSize: 2,
				search: "PAGED-",
			});
			const second = await callerFor(ids.adminA).assets.listAssets({
				page: 2,
				pageSize: 2,
				search: "PAGED-",
			});

			expect(first.rows).toHaveLength(2);
			expect(second.rows).toHaveLength(1);
			expect(first.total).toBe(3);
			expect(first.pageCount).toBe(2);
			// No row appears on both pages — the order is total, not arbitrary.
			expect(
				first.rows.map((row) => row.id).includes(second.rows[0]?.id ?? ""),
			).toBe(false);
		});
	});

	describe("createAsset", () => {
		it("files the new asset under the caller's own purveyor", async () => {
			const created = await callerFor(ids.employeeA).assets.createAsset(
				newAsset("CREATED-BY-EMPLOYEE"),
			);

			const { rows } = await pool.query(
				"select water_purveyor_id from bfa_assets where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("ignores a water purveyor sent by the client", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset({
				...newAsset("TRIED-TO-PICK-A-TENANT"),
				// Not part of the input shape — the cast is the point: even a client
				// that sends it gets its own tenant.
				waterPurveyorId: wpB,
			} as unknown as Inputs["createAsset"]);

			const { rows } = await pool.query(
				"select water_purveyor_id from bfa_assets where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("stores the annual test date the reminder schedule runs from", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("ANNUAL-DATE", { annualTestDate: "2028-06-30" }),
			);

			expect(created.annualTestDate).toBe("2028-06-30");
		});

		it("stores the assembly details", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("ASSEMBLY-DETAILS", {
					bfaType: "DCDA-2",
					make: "Watts",
					model: "909",
					serialNumber: "SN-88120",
					size: "2 in",
					assemblyLocation: "Meter pit, north side",
				}),
			);

			expect(created).toMatchObject({
				bfaType: "DCDA-2",
				make: "Watts",
				model: "909",
				serialNumber: "SN-88120",
				size: "2 in",
				assemblyLocation: "Meter pit, north side",
			});
		});

		it("never lets the client choose the status", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset({
				...newAsset("TRIED-TO-PICK-A-STATUS"),
				assetStatus: "past_due",
			} as unknown as Inputs["createAsset"]);

			// The column default, not what was asked for. Only the scheduler moves it.
			expect(created.assetStatus).toBe("active");
		});

		it("refuses a BIN already used in the same purveyor", async () => {
			await callerFor(ids.adminA).assets.createAsset(newAsset("DUPLICATE-BIN"));

			await expect(
				callerFor(ids.adminA).assets.createAsset(newAsset("DUPLICATE-BIN")),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("allows the same BIN in a different purveyor", async () => {
			// The constraint is per tenant: two purveyors numbering their valves the
			// same way is normal, not a collision.
			const created = await callerFor(ids.adminB).assets.createAsset(
				newAsset("DUPLICATE-BIN"),
			);

			expect(created.bin).toBe("DUPLICATE-BIN");
		});

		it("emits a structured audit line naming the actor, asset and tenant", async () => {
			const lines = captureLogs();

			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("AUDITED-CREATE"),
			);

			const entry = lines.find((line) => line.event === "bfa_asset_created");
			expect(entry).toMatchObject({
				event: "bfa_asset_created",
				actor_id: ids.adminA,
				asset_id: created.id,
				wp_id: wpA,
				bin: "AUDITED-CREATE",
			});
			expect(typeof entry?.timestamp).toBe("string");
		});
	});

	describe("updateAsset", () => {
		it("updates an asset in the caller's own purveyor", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("BEFORE-EDIT"),
			);

			const updated = await callerFor(ids.adminA).assets.updateAsset(
				asUpdate(created, { serviceAddress: "44 Reservoir Lane" }),
			);

			expect(updated.serviceAddress).toBe("44 Reservoir Lane");
		});

		it("refuses an asset id from the other tenant, and leaves the row untouched", async () => {
			await expect(
				callerFor(ids.adminA).assets.updateAsset({
					id: assetB,
					bin: "TAKEN-OVER",
					bfaType: "PVB",
					serviceAddress: "Taken Over",
					make: null,
					model: null,
					serialNumber: null,
					size: null,
					assemblyLocation: null,
					annualTestDate: "2029-01-01",
				}),
			).rejects.toThrow(/not found/i);

			const { rows } = await pool.query(
				"select bin, service_address from bfa_assets where id = $1",
				[assetB],
			);

			// Not found, not merely refused: the other tenant's row is unchanged.
			expect(rows[0]).toMatchObject({
				bin: "SHARED-BIN",
				service_address: "1 Shared Way",
			});
		});

		it("logs a BIN change with the old value, the new one and the actor", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("BIN-BEFORE"),
			);

			const lines = captureLogs();

			const updated = await callerFor(ids.adminA).assets.updateAsset(
				asUpdate(created, { bin: "BIN-AFTER" }),
			);

			expect(updated.bin).toBe("BIN-AFTER");
			expect(
				lines.find((line) => line.event === "bfa_asset_bin_changed"),
			).toMatchObject({
				event: "bfa_asset_bin_changed",
				actor_id: ids.adminA,
				asset_id: created.id,
				wp_id: wpA,
				from: "BIN-BEFORE",
				to: "BIN-AFTER",
			});
		});

		it("logs no BIN change when only another field moved", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("BIN-UNMOVED"),
			);

			const lines = captureLogs();

			await callerFor(ids.adminA).assets.updateAsset(
				asUpdate(created, { size: "3 in" }),
			);

			expect(lines.some((line) => line.event === "bfa_asset_updated")).toBe(
				true,
			);
			expect(lines.some((line) => line.event === "bfa_asset_bin_changed")).toBe(
				false,
			);
		});

		it("refuses a BIN already used by another asset in the purveyor", async () => {
			await callerFor(ids.adminA).assets.createAsset(newAsset("TAKEN-ALREADY"));
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("WANTS-TAKEN-BIN"),
			);

			await expect(
				callerFor(ids.adminA).assets.updateAsset(
					asUpdate(created, { bin: "TAKEN-ALREADY" }),
				),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("writes nothing when the save changed nothing", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("SAVED-WITHOUT-EDITING", { make: "Watts" }),
			);

			const lines = captureLogs();

			// Opening the edit dialog and pressing save. Every field is sent on every
			// save, so the request looks exactly like a real edit.
			const returned = await callerFor(ids.adminA).assets.updateAsset(
				asUpdate(created),
			);

			const { rows } = await pool.query(
				"select updated_at from bfa_assets where id = $1",
				[created.id],
			);

			expect(returned).toMatchObject({ id: created.id, bin: created.bin });
			// `updated_at` still means "when this row last changed"…
			expect(new Date(rows[0]?.updated_at).getTime()).toBe(
				created.updatedAt.getTime(),
			);
			// …and the audit trail carries no line for a change that never happened.
			expect(lines.some((line) => line.event === "bfa_asset_updated")).toBe(
				false,
			);
			expect(lines.some((line) => line.event === "bfa_asset_bin_changed")).toBe(
				false,
			);
		});

		it("still writes when only one field moved", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("ONE-FIELD-MOVES", { make: "Watts" }),
			);

			const updated = await callerFor(ids.adminA).assets.updateAsset(
				asUpdate(created, { make: "Febco" }),
			);

			expect(updated.make).toBe("Febco");
			expect(updated.updatedAt.getTime()).not.toBe(created.updatedAt.getTime());
		});

		it("treats clearing an optional field as a real change", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("CLEARS-A-MODEL", { model: "909" }),
			);

			const updated = await callerFor(ids.adminA).assets.updateAsset(
				asUpdate(created, { model: null }),
			);

			expect(updated.model).toBeNull();
		});
	});

	describe("assignCustomer", () => {
		it("attaches a customer and opens an assignment for them", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("FIRST-ASSIGNMENT"),
			);

			const detail = await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});

			expect(detail.asset.currentCustomerId).toBe(customerA);
			expect(detail.assignments).toHaveLength(1);
			expect(detail.assignments[0]).toMatchObject({
				customerId: customerA,
				endDate: null,
			});
		});

		it("keeps the previous assignment, closed with an end date", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("REASSIGNED"),
			);

			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});
			const detail = await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA2,
			});

			expect(detail.asset.currentCustomerId).toBe(customerA2);
			expect(detail.assignments).toHaveLength(2);

			const [current, previous] = detail.assignments;

			// The new occupancy is open…
			expect(current).toMatchObject({ customerId: customerA2, endDate: null });
			// …and the old one is preserved rather than overwritten, closed on the
			// day the new one started.
			expect(previous?.customerId).toBe(customerA);
			expect(previous?.endDate).toBe(current?.startDate);
		});

		it("refuses a customer belonging to another purveyor", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("CROSS-TENANT-CUSTOMER"),
			);

			await expect(
				callerFor(ids.adminA).assets.assignCustomer({
					assetId: created.id,
					customerId: customerB,
				}),
			).rejects.toThrow(/no customer with that id/i);

			const { rows } = await pool.query(
				"select current_customer_id from bfa_assets where id = $1",
				[created.id],
			);
			const assignments = await pool.query(
				"select id from customer_assignments where bfa_asset_id = $1",
				[created.id],
			);

			// Refused *and* inert: no pointer moved, no half-written history.
			expect(rows[0]?.current_customer_id).toBeNull();
			expect(assignments.rows).toHaveLength(0);
		});

		it("refuses an asset belonging to another purveyor", async () => {
			await expect(
				callerFor(ids.adminA).assets.assignCustomer({
					assetId: assetB,
					customerId: customerA,
				}),
			).rejects.toThrow(/asset not found/i);
		});

		it("refuses a suspended customer that the request has not acknowledged", async () => {
			// Attaching one stops this asset's automated email entirely. The screen
			// confirms first; this is the rule that confirmation satisfies, so a
			// client that has never heard of the flag gets a refusal rather than a
			// silently muted asset.
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("SUSPENDED-UNACKNOWLEDGED"),
			);

			await expect(
				callerFor(ids.adminA).assets.assignCustomer({
					assetId: created.id,
					customerId: suspendedCustomerA,
				}),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

			const { rows } = await pool.query(
				"select current_customer_id from bfa_assets where id = $1",
				[created.id],
			);
			const assignments = await pool.query(
				"select id from customer_assignments where bfa_asset_id = $1",
				[created.id],
			);

			// Refused and inert, the same as the cross-tenant case.
			expect(rows[0]?.current_customer_id).toBeNull();
			expect(assignments.rows).toHaveLength(0);
		});

		it("attaches a suspended customer once the request acknowledges it", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("SUSPENDED-ACKNOWLEDGED"),
			);

			const lines = captureLogs();

			const detail = await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: suspendedCustomerA,
				acknowledgeSuspendedCustomer: true,
			});

			expect(detail.asset.currentCustomerId).toBe(suspendedCustomerA);
			expect(detail.asset.currentCustomerStatus).toBe("suspended");
			// The audit line carries why this asset's notices go quiet from today.
			expect(
				lines.find((line) => line.event === "bfa_asset_customer_assigned"),
			).toMatchObject({ to_customer_suspended: true });
		});

		it("does not ask for an acknowledgement about a customer already attached", async () => {
			// Suspending somebody after they were attached must not turn re-saving
			// the asset into a confirmation prompt for a change nobody is making.
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("SUSPENDED-AFTER-ATTACHING"),
			);
			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});
			await pool.query(
				"update customers set status = 'suspended' where id = $1",
				[customerA],
			);

			const detail = await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});

			expect(detail.asset.currentCustomerId).toBe(customerA);
			expect(detail.assignments).toHaveLength(1);

			await pool.query("update customers set status = 'active' where id = $1", [
				customerA,
			]);
		});

		it("writes nothing when the customer is already the one attached", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("ALREADY-ATTACHED"),
			);
			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});

			const lines = captureLogs();

			const detail = await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});

			// One continuous tenancy, not two beside each other — re-attaching the
			// customer who is already there is not a move anybody made.
			expect(detail.assignments).toHaveLength(1);
			expect(detail.assignments[0]?.endDate).toBeNull();
			expect(
				lines.some((line) => line.event === "bfa_asset_customer_assigned"),
			).toBe(false);
		});

		it("emits a structured audit line carrying both customers", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("AUDITED-ASSIGNMENT"),
			);
			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA2,
			});

			expect(
				lines.find((line) => line.event === "bfa_asset_customer_assigned"),
			).toMatchObject({
				actor_id: ids.adminA,
				asset_id: created.id,
				wp_id: wpA,
				from: customerA,
				to: customerA2,
			});
		});
	});

	describe("getAsset", () => {
		it("returns the current occupant and the whole history", async () => {
			const created = await callerFor(ids.adminA).assets.createAsset(
				newAsset("DETAIL-VIEW"),
			);
			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA,
			});
			await callerFor(ids.adminA).assets.assignCustomer({
				assetId: created.id,
				customerId: customerA2,
			});

			const detail = await callerFor(ids.adminA).assets.getAsset({
				id: created.id,
			});

			expect(detail.asset.currentCustomerName).toBe("Tomas Reyes");
			expect(detail.assignments.map((row) => row.customerName)).toEqual([
				"Tomas Reyes",
				"Marta Ellison",
			]);
		});

		it("refuses an asset id from the other tenant", async () => {
			await expect(
				callerFor(ids.adminA).assets.getAsset({ id: assetB }),
			).rejects.toThrow(/not found/i);
		});
	});
});
