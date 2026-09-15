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

/**
 * The repair-company procedures against real Postgres: who may call them, what
 * they can see, and — the part that matters — what happens when a caller names
 * a company belonging to somebody else.
 *
 * Two purveyors are seeded with deliberately interchangeable companies. A leak
 * between them has to look like a leak, not like a plausible row.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary and have their own suite
 * in `packages/db/src/repair-companies-rls.test.ts`.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wpA = randomUUID();
const wpB = randomUUID();
const ids = {
	adminA: randomUUID(),
	subAdminA: randomUUID(),
	employeeA: randomUUID(),
	adminB: randomUUID(),
	certifier: randomUUID(),
	superAdmin: randomUUID(),
	orphanedWpAdmin: randomUUID(),
};
const companyA = randomUUID();
const companyB = randomUUID();

let pool: pg.Pool;
type RepairCompanyRow = {
	id: string;
	companyName: string;
	phone: string | null;
	email: string | null;
	status: "active" | "inactive";
	createdAt: Date;
	updatedAt: Date;
};
type RepairCompanyInput = {
	companyName: string;
	phone?: string | null;
	email?: string | null;
	status?: "active" | "inactive";
};

let callerFor: (profileId: string) => {
	repairCompanies: {
		listRepairCompanies: () => Promise<RepairCompanyRow[]>;
		createRepairCompany: (
			input: RepairCompanyInput,
		) => Promise<RepairCompanyRow>;
		updateRepairCompany: (
			input: RepairCompanyInput & { id: string },
		) => Promise<RepairCompanyRow>;
	};
};

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

describeDb("repair company procedures", () => {
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
			 values ($1, 'Repair Fixture Water Works', 'REPAIR-A', 'active'),
			        ($2, 'Repair Fixture Water Works', 'REPAIR-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string][] = [
			[ids.adminA, wpA, "wp_admin"],
			[ids.subAdminA, wpA, "wp_sub_admin"],
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
				 values ($1, $2, 'Repair Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}

		// Same name in both tenants: if one shows up in the other's list, it is
		// unmistakably the wrong row rather than a plausible one.
		await pool.query(
			`insert into repair_companies (id, water_purveyor_id, company_name, phone, email, status)
			 values ($1, $2, 'Shared Name Backflow', '555-0100', 'shared@example.com', 'active'),
			        ($3, $4, 'Shared Name Backflow', '555-0100', 'shared@example.com', 'active')`,
			[companyA, wpA, companyB, wpB],
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from repair_companies where water_purveyor_id = any($1::uuid[])",
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
			// A certifier records that an assembly failed; who the purveyor
			// recommends for the repair is not theirs to read or edit.
			await expect(
				callerFor(ids.certifier).repairCompanies.listRepairCompanies(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a Super-Admin, rather than showing every tenant's companies", async () => {
			await expect(
				callerFor(ids.superAdmin).repairCompanies.listRepairCompanies(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			await expect(
				callerFor(ids.orphanedWpAdmin).repairCompanies.listRepairCompanies(),
			).rejects.toThrow(/no water purveyor/i);
		});

		it("lets every WP role in the tenant read the list", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows =
					await callerFor(reader).repairCompanies.listRepairCompanies();
				expect(rows.map((row) => row.id)).toContain(companyA);
				expect(rows.map((row) => row.id)).not.toContain(companyB);
			}
		});

		it("refuses a certifier the write paths too, not just the read", async () => {
			await expect(
				callerFor(ids.certifier).repairCompanies.createRepairCompany({
					companyName: "Certifier Tried To Add",
				}),
			).rejects.toThrow(/water purveyor only/i);

			await expect(
				callerFor(ids.certifier).repairCompanies.updateRepairCompany({
					id: companyA,
					companyName: "Certifier Tried To Edit",
				}),
			).rejects.toThrow(/water purveyor only/i);
		});
	});

	describe("listRepairCompanies", () => {
		it("shows a caller only their own purveyor's companies", async () => {
			const fromA = await callerFor(
				ids.adminA,
			).repairCompanies.listRepairCompanies();
			const fromB = await callerFor(
				ids.adminB,
			).repairCompanies.listRepairCompanies();

			expect(fromA.map((row) => row.id)).toContain(companyA);
			expect(fromA.map((row) => row.id)).not.toContain(companyB);
			expect(fromB.map((row) => row.id)).toContain(companyB);
			expect(fromB.map((row) => row.id)).not.toContain(companyA);
		});

		it("keeps inactive companies in the management list", async () => {
			// The failure workflow filters on `status`; this screen does not. A
			// company that disappeared when it was deactivated could never be
			// corrected or reactivated.
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Zzz Deactivated Repairs",
				status: "inactive",
			});

			const rows = await callerFor(
				ids.adminA,
			).repairCompanies.listRepairCompanies();

			expect(rows.map((row) => row.id)).toContain(created.id);
		});

		it("sorts by company name", async () => {
			const names = (
				await callerFor(ids.adminB).repairCompanies.listRepairCompanies()
			).map((row) => row.companyName);

			expect(names).toEqual([...names].sort());
		});
	});

	describe("createRepairCompany", () => {
		it("files the new company under the caller's own purveyor", async () => {
			const created = await callerFor(
				ids.employeeA,
			).repairCompanies.createRepairCompany({
				companyName: "Created By Employee",
			});

			const { rows } = await pool.query(
				"select water_purveyor_id from repair_companies where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("ignores a water purveyor sent by the client", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Tried To Pick A Tenant",
				// Not part of the input shape — the cast is the point: even a client
				// that sends it gets its own tenant.
				waterPurveyorId: wpB,
			} as unknown as RepairCompanyInput);

			const { rows } = await pool.query(
				"select water_purveyor_id from repair_companies where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("stores a blank contact field as null rather than an empty string", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Reachable By Neither",
				phone: "",
				email: "",
			});

			expect(created.phone).toBeNull();
			expect(created.email).toBeNull();
		});

		it("refuses a blank company name", async () => {
			await expect(
				callerFor(ids.adminA).repairCompanies.createRepairCompany({
					companyName: "   ",
				}),
			).rejects.toThrow();
		});

		it("refuses an email that is not an email", async () => {
			await expect(
				callerFor(ids.adminA).repairCompanies.createRepairCompany({
					companyName: "Bad Address Repairs",
					email: "dispatch@",
				}),
			).rejects.toThrow();
		});

		it("defaults a new company to active, so it reaches the next failure notice", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Defaults To Active",
			});

			expect(created.status).toBe("active");
		});

		it("emits a structured audit line naming the actor, company and tenant", async () => {
			const lines = captureLogs();

			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Audited Create",
			});

			const entry = lines.find(
				(line) => line.event === "repair_company_created",
			);
			expect(entry).toMatchObject({
				event: "repair_company_created",
				actor_id: ids.adminA,
				effective_profile_id: ids.adminA,
				repair_company_id: created.id,
				wp_id: wpA,
			});
			expect(typeof entry?.timestamp).toBe("string");
		});
	});

	describe("updateRepairCompany", () => {
		it("updates a company in the caller's own purveyor", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Before Rename",
			});

			const updated = await callerFor(
				ids.adminA,
			).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: "After Rename",
				phone: created.phone,
				email: created.email,
				status: "active",
			});

			expect(updated.companyName).toBe("After Rename");
		});

		it("refuses a company id from the other tenant, and leaves the row untouched", async () => {
			await expect(
				callerFor(ids.adminA).repairCompanies.updateRepairCompany({
					id: companyB,
					companyName: "Taken Over",
					status: "inactive",
				}),
			).rejects.toThrow(/not found/i);

			const { rows } = await pool.query(
				"select company_name, status from repair_companies where id = $1",
				[companyB],
			);

			// Not found, not merely refused: the other tenant's row is unchanged.
			expect(rows[0]).toMatchObject({
				company_name: "Shared Name Backflow",
				status: "active",
			});
		});

		it("refuses an id that belongs to nobody", async () => {
			await expect(
				callerFor(ids.adminA).repairCompanies.updateRepairCompany({
					id: randomUUID(),
					companyName: "Ghost Repairs",
				}),
			).rejects.toThrow(/not found/i);
		});

		it("deactivates by flipping the status, and keeps the row", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "No Longer Approved",
				phone: "555-0199",
			});

			const updated = await callerFor(
				ids.adminA,
			).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: created.companyName,
				phone: created.phone,
				email: created.email,
				status: "inactive",
			});

			expect(updated.status).toBe("inactive");

			const { rows } = await pool.query(
				"select company_name, phone, status from repair_companies where id = $1",
				[created.id],
			);

			// Deactivation is a status change and nothing else — the contact details
			// a past failure notice quoted are still on the row.
			expect(rows[0]).toMatchObject({
				company_name: "No Longer Approved",
				phone: "555-0199",
				status: "inactive",
			});
		});

		it("reactivates a deactivated company", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Approved Again",
				status: "inactive",
			});

			const updated = await callerFor(
				ids.adminA,
			).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: created.companyName,
				phone: created.phone,
				email: created.email,
				status: "active",
			});

			expect(updated.status).toBe("active");
		});

		it("writes nothing when the save changed nothing", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Saved Without Editing",
				phone: "555-0101",
				email: "saved@example.com",
			});

			const lines = captureLogs();

			// Opening the edit dialog and pressing save. Every field is sent on
			// every save, so the request looks exactly like a real edit.
			const returned = await callerFor(
				ids.adminA,
			).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: created.companyName,
				phone: created.phone,
				email: created.email,
				status: created.status,
			});

			const { rows } = await pool.query(
				"select updated_at from repair_companies where id = $1",
				[created.id],
			);

			// The row comes back, so the client has nothing to handle differently.
			expect(returned).toMatchObject({
				id: created.id,
				companyName: created.companyName,
			});
			// But `updated_at` still means "when this row last changed"…
			expect(new Date(rows[0]?.updated_at).getTime()).toBe(
				created.updatedAt.getTime(),
			);
			// …and the audit trail carries no line for a change that never happened.
			expect(
				lines.some((line) => line.event === "repair_company_updated"),
			).toBe(false);
			expect(
				lines.some((line) => line.event === "repair_company_status_changed"),
			).toBe(false);
		});

		it("still writes when only one field moved", async () => {
			// The guard above must not swallow a real edit — a single changed
			// character is an update.
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "One Field Moves",
				phone: "555-0102",
			});

			const updated = await callerFor(
				ids.adminA,
			).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: created.companyName,
				phone: "555-0103",
				email: created.email,
				status: created.status,
			});

			expect(updated.phone).toBe("555-0103");
			expect(updated.updatedAt.getTime()).not.toBe(created.updatedAt.getTime());
		});

		it("treats clearing a contact field as a real change", async () => {
			// `null` and the value it replaces are both "sent every time", so the
			// comparison has to tell them apart rather than reading both as absent.
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Clears A Phone",
				phone: "555-0104",
			});

			const updated = await callerFor(
				ids.adminA,
			).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: created.companyName,
				phone: null,
				email: created.email,
				status: created.status,
			});

			expect(updated.phone).toBeNull();
		});

		it("logs a status change on its own line, on top of the update line", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Audited Deactivate",
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: created.companyName,
				phone: created.phone,
				email: created.email,
				status: "inactive",
			});

			expect(
				lines.find((line) => line.event === "repair_company_status_changed"),
			).toMatchObject({
				actor_id: ids.adminA,
				effective_profile_id: ids.adminA,
				repair_company_id: created.id,
				wp_id: wpA,
				from: "active",
				to: "inactive",
			});
			expect(
				lines.some((line) => line.event === "repair_company_updated"),
			).toBe(true);
		});

		it("does not log a status change when the status did not move", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Audited Rename Only",
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: "Renamed Only",
				phone: created.phone,
				email: created.email,
				status: "active",
			});

			expect(
				lines.some((line) => line.event === "repair_company_status_changed"),
			).toBe(false);
		});

		it("ignores a water purveyor sent alongside an update", async () => {
			const created = await callerFor(
				ids.adminA,
			).repairCompanies.createRepairCompany({
				companyName: "Tried To Change Tenant",
			});

			await callerFor(ids.adminA).repairCompanies.updateRepairCompany({
				id: created.id,
				companyName: "Tried To Change Tenant",
				phone: "555-0105",
				email: created.email,
				status: created.status,
				waterPurveyorId: wpB,
			} as unknown as RepairCompanyInput & { id: string });

			const { rows } = await pool.query(
				"select water_purveyor_id from repair_companies where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});
	});
});
