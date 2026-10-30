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
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

/**
 * The WP certifier procedures against real Postgres: who may call them, what
 * they can see, and — the part that matters — what happens when a caller names
 * a certifier who works for somebody else.
 *
 * Two purveyors are seeded with deliberately interchangeable certifiers, plus
 * one certifier authorized for both. That third row is what proves the join is
 * a join: a shared certifier must appear on both screens, while an exclusive
 * one must appear on neither but its own.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary with their own suite in
 * `packages/db/src/certifiers-rls.test.ts`.
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
	superAdmin: randomUUID(),
	orphanedWpAdmin: randomUUID(),
	// Profile ids for the certifiers themselves.
	certifierAProfile: randomUUID(),
	certifierBProfile: randomUUID(),
	certifierSharedProfile: randomUUID(),
};
const certifierA = randomUUID();
const certifierB = randomUUID();
const certifierShared = randomUUID();

let pool: pg.Pool;

type CertifierRow = {
	id: string;
	fullName: string | null;
	company: string | null;
	idNumber: string | null;
	licenseExpirationDate: string | null;
	status: "active" | "blocked";
	certifierType?: "internal" | "external";
};

type CertifierTypeRow = {
	id: string;
	fullName: string | null;
	certifierType: "internal" | "external";
};

let callerFor: (profileId: string) => {
	certifiers: {
		listWpCertifiers: () => Promise<CertifierRow[]>;
		setCertifierStatus: (input: {
			id: string;
			status: "active" | "blocked";
		}) => Promise<CertifierRow>;
		setCertifierType: (input: {
			id: string;
			certifierType: "internal" | "external";
		}) => Promise<CertifierTypeRow>;
	};
	whoami: () => Promise<unknown>;
};

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

async function statusOf(certifierId: string) {
	const { rows } = await pool.query(
		"select status, updated_at from certifiers where id = $1",
		[certifierId],
	);

	return rows[0] as { status: string; updated_at: Date };
}

describeDb("WP certifier procedures", () => {
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
			 values ($1, 'Certifier Fixture Water Works', 'CERT-A', 'active'),
			        ($2, 'Certifier Fixture Water Works', 'CERT-B', 'active')`,
			[wpA, wpB],
		);

		const profileRows: [string, string | null, string, string][] = [
			[ids.adminA, wpA, "wp_admin", "Fixture Admin A"],
			[ids.subAdminA, wpA, "wp_sub_admin", "Fixture SubAdmin A"],
			[ids.employeeA, wpA, "wp_employee", "Fixture Employee A"],
			[ids.adminB, wpB, "wp_admin", "Fixture Admin B"],
			[ids.superAdmin, null, "super_admin", "Fixture Super Admin"],
			// A WP role with no purveyor on the row — the broken state `wpProcedure`
			// refuses rather than running an unscoped query for.
			[ids.orphanedWpAdmin, null, "wp_admin", "Fixture Orphaned Admin"],
			// Certifiers carry a null `water_purveyor_id` by design: their reach is
			// `wp_certifier_authorizations`, not a tenant column.
			[ids.certifierAProfile, null, "certifier", "Ada Tester"],
			[ids.certifierBProfile, null, "certifier", "Ada Tester"],
			[ids.certifierSharedProfile, null, "certifier", "Zoe Shared"],
		];

		for (const [id, wp, role, fullName] of profileRows) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, $3, $4::global_role, 'active')`,
				[id, wp, fullName, role],
			);
		}

		// Same name, same company, same licence number in both tenants: if one
		// shows up in the other's list it is unmistakably the wrong row.
		await pool.query(
			`insert into certifiers (id, profile_id, company, id_number, license_expiration_date, status)
			 values ($1, $2, 'Shared Name Testing', 'LIC-0001', '2027-01-31', 'active'),
			        ($3, $4, 'Shared Name Testing', 'LIC-0001', '2027-01-31', 'active'),
			        ($5, $6, 'Two Purveyor Testing', 'LIC-0002', '2027-06-30', 'active')`,
			[
				certifierA,
				ids.certifierAProfile,
				certifierB,
				ids.certifierBProfile,
				certifierShared,
				ids.certifierSharedProfile,
			],
		);

		await pool.query(
			`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
			 values ($1, $2, 'active'), ($3, $4, 'active'), ($5, $2, 'active'), ($5, $4, 'active')`,
			[certifierA, wpA, certifierB, wpB, certifierShared],
		);
	});

	beforeEach(async () => {
		// Every fixture certifier starts active, so a test that blocks one cannot
		// change what the next test reads.
		await pool.query(
			"update certifiers set status = 'active' where id = any($1::uuid[])",
			[[certifierA, certifierB, certifierShared]],
		);
		await pool.query(
			"update wp_certifier_authorizations set certifier_type = 'external' where certifier_id = any($1::uuid[])",
			[[certifierA, certifierB, certifierShared]],
		);
	});

	async function typeOf(certifierId: string, waterPurveyorId: string) {
		const { rows } = await pool.query(
			"select certifier_type from wp_certifier_authorizations where certifier_id = $1 and water_purveyor_id = $2",
			[certifierId, waterPurveyorId],
		);

		return rows[0]?.certifier_type as string | undefined;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id = any($1::uuid[])",
			[[certifierA, certifierB, certifierShared]],
		);
		await pool.query("delete from certifiers where id = any($1::uuid[])", [
			[certifierA, certifierB, certifierShared],
		]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB],
		]);
		await pool.end();
	});

	describe("who may call them at all", () => {
		it("lets every WP role read the list", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await callerFor(reader).certifiers.listWpCertifiers();

				expect(rows.map((row) => row.id)).toContain(certifierA);
			}
		});

		it("refuses a certifier the WP-scoped list", async () => {
			// A certifier has no purveyor to scope this to. Their own screens read
			// their authorizations the other way round.
			await expect(
				callerFor(ids.certifierAProfile).certifiers.listWpCertifiers(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a Super-Admin, rather than showing every tenant's certifiers", async () => {
			await expect(
				callerFor(ids.superAdmin).certifiers.listWpCertifiers(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			await expect(
				callerFor(ids.orphanedWpAdmin).certifiers.listWpCertifiers(),
			).rejects.toThrow(/no water purveyor/i);
		});

		it("refuses a certifier and a Super-Admin the status mutation too", async () => {
			for (const caller of [ids.certifierAProfile, ids.superAdmin]) {
				await expect(
					callerFor(caller).certifiers.setCertifierStatus({
						id: certifierA,
						status: "blocked",
					}),
				).rejects.toThrow(/water purveyor only/i);
			}
		});

		it("refuses a WP Employee the status mutation, and leaves the row alone", async () => {
			// The one place the three WP roles differ on this screen. Employees list
			// and invite; taking somebody's platform access away is not clerk work.
			await expect(
				callerFor(ids.employeeA).certifiers.setCertifierStatus({
					id: certifierA,
					status: "blocked",
				}),
			).rejects.toThrow(/admin or subadmin/i);

			expect((await statusOf(certifierA)).status).toBe("active");
		});

		it("lets a WP Admin and a WP SubAdmin set the status", async () => {
			for (const writer of [ids.adminA, ids.subAdminA]) {
				const blocked = await callerFor(writer).certifiers.setCertifierStatus({
					id: certifierA,
					status: "blocked",
				});
				expect(blocked.status).toBe("blocked");

				const unblocked = await callerFor(writer).certifiers.setCertifierStatus(
					{
						id: certifierA,
						status: "active",
					},
				);
				expect(unblocked.status).toBe("active");
			}
		});
	});

	describe("listWpCertifiers", () => {
		it("shows a caller only the certifiers authorized for their own purveyor", async () => {
			const fromA = await callerFor(ids.adminA).certifiers.listWpCertifiers();
			const fromB = await callerFor(ids.adminB).certifiers.listWpCertifiers();

			expect(fromA.map((row) => row.id)).toContain(certifierA);
			expect(fromA.map((row) => row.id)).not.toContain(certifierB);
			expect(fromB.map((row) => row.id)).toContain(certifierB);
			expect(fromB.map((row) => row.id)).not.toContain(certifierA);
		});

		it("shows a certifier authorized for two purveyors on both lists", async () => {
			// The row that proves this is a join and not a tenant column: one
			// `certifiers` row, two authorizations, two screens.
			for (const reader of [ids.adminA, ids.adminB]) {
				const rows = await callerFor(reader).certifiers.listWpCertifiers();
				expect(rows.map((row) => row.id)).toContain(certifierShared);
			}
		});

		it("returns the fields the table renders", async () => {
			const row = (
				await callerFor(ids.adminA).certifiers.listWpCertifiers()
			).find((candidate) => candidate.id === certifierShared);

			expect(row).toMatchObject({
				id: certifierShared,
				fullName: "Zoe Shared",
				company: "Two Purveyor Testing",
				idNumber: "LIC-0002",
				licenseExpirationDate: "2027-06-30",
				status: "active",
				certifierType: "external",
			});
		});

		it("keeps blocked certifiers in the management list", async () => {
			// A certifier who disappeared from the list when they were blocked could
			// never be unblocked.
			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			const rows = await callerFor(ids.adminA).certifiers.listWpCertifiers();

			expect(rows.map((row) => row.id)).toContain(certifierA);
		});

		it("sorts by name", async () => {
			const names = (
				await callerFor(ids.adminA).certifiers.listWpCertifiers()
			).map((row) => row.fullName);

			expect(names).toEqual([...names].sort());
		});

		it("lists one row per certifier, not one per authorization", async () => {
			const rows = await callerFor(ids.adminA).certifiers.listWpCertifiers();
			const shared = rows.filter((row) => row.id === certifierShared);

			expect(shared).toHaveLength(1);
		});
	});

	describe("setCertifierStatus", () => {
		it("blocks and unblocks a certifier in the caller's own purveyor", async () => {
			const blocked = await callerFor(ids.adminA).certifiers.setCertifierStatus(
				{
					id: certifierA,
					status: "blocked",
				},
			);

			expect(blocked.status).toBe("blocked");
			expect((await statusOf(certifierA)).status).toBe("blocked");

			const unblocked = await callerFor(
				ids.adminA,
			).certifiers.setCertifierStatus({
				id: certifierA,
				status: "active",
			});

			expect(unblocked.status).toBe("active");
			expect((await statusOf(certifierA)).status).toBe("active");
		});

		it("refuses a certifier id from the other tenant, and leaves the row untouched", async () => {
			await expect(
				callerFor(ids.adminA).certifiers.setCertifierStatus({
					id: certifierB,
					status: "blocked",
				}),
			).rejects.toThrow(/not found/i);

			// Not found, not merely refused: the other tenant's row is unchanged.
			expect((await statusOf(certifierB)).status).toBe("active");
		});

		it("refuses an id that belongs to nobody", async () => {
			await expect(
				callerFor(ids.adminA).certifiers.setCertifierStatus({
					id: randomUUID(),
					status: "blocked",
				}),
			).rejects.toThrow(/not found/i);
		});

		it("accepts only an id and a status", async () => {
			// A strict input, so a client that sends a profile column is refused
			// rather than quietly having it dropped — a silently ignored field looks
			// like a successful edit to whatever sent it.
			await expect(
				callerFor(ids.adminA).certifiers.setCertifierStatus({
					id: certifierA,
					status: "blocked",
					company: "Renamed By A WP",
				} as unknown as { id: string; status: "blocked" }),
			).rejects.toThrow();

			const { rows } = await pool.query(
				"select company, status from certifiers where id = $1",
				[certifierA],
			);
			expect(rows[0]).toMatchObject({
				company: "Shared Name Testing",
				status: "active",
			});
		});

		it("refuses a status that is not active or blocked", async () => {
			await expect(
				callerFor(ids.adminA).certifiers.setCertifierStatus({
					id: certifierA,
					status: "inactive" as unknown as "blocked",
				}),
			).rejects.toThrow();
		});

		it("writes only the status — the certifier's own record is untouched", async () => {
			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			const { rows } = await pool.query(
				`select c.company, c.id_number, c.license_expiration_date, p.full_name
				 from certifiers c join profiles p on p.id = c.profile_id
				 where c.id = $1`,
				[certifierA],
			);

			expect(rows[0]).toMatchObject({
				company: "Shared Name Testing",
				id_number: "LIC-0001",
				full_name: "Ada Tester",
			});
		});

		it("writes nothing when the status is already what was asked for", async () => {
			const before = await statusOf(certifierA);
			const lines = captureLogs();

			const returned = await callerFor(
				ids.adminA,
			).certifiers.setCertifierStatus({
				id: certifierA,
				status: "active",
			});

			const after = await statusOf(certifierA);

			// The row comes back, so the client has nothing to handle differently.
			expect(returned).toMatchObject({ id: certifierA, status: "active" });
			// But `updated_at` still means "when this row last changed" — the
			// `set_updated_at` trigger moves it on any UPDATE at all, so the only
			// way to keep it honest is to issue no UPDATE.
			expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
			// …and the audit trail carries no line for a change that never happened.
			expect(
				lines.some((line) => line.event === "certifier_status_changed"),
			).toBe(false);
		});

		it("emits a structured audit line naming the actor, certifier, tenant and both statuses", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			const entry = lines.find(
				(line) => line.event === "certifier_status_changed",
			);

			expect(entry).toMatchObject({
				event: "certifier_status_changed",
				actor_id: ids.adminA,
				certifier_id: certifierA,
				wp_id: wpA,
				from: "active",
				to: "blocked",
			});
			expect(typeof entry?.timestamp).toBe("string");
		});

		it("logs the unblock as its own transition", async () => {
			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "active",
			});

			expect(
				lines.find((line) => line.event === "certifier_status_changed"),
			).toMatchObject({ from: "blocked", to: "active" });
		});

		it("lets either purveyor block a certifier they share", async () => {
			await callerFor(ids.adminB).certifiers.setCertifierStatus({
				id: certifierShared,
				status: "blocked",
			});

			expect((await statusOf(certifierShared)).status).toBe("blocked");
		});
	});

	describe("setCertifierType", () => {
		it("moves a certifier between internal and external in the caller's own purveyor", async () => {
			const moved = await callerFor(ids.adminA).certifiers.setCertifierType({
				id: certifierA,
				certifierType: "internal",
			});

			expect(moved).toMatchObject({
				id: certifierA,
				certifierType: "internal",
			});
			expect(await typeOf(certifierA, wpA)).toBe("internal");

			const row = (
				await callerFor(ids.adminA).certifiers.listWpCertifiers()
			).find((candidate) => candidate.id === certifierA);
			expect(row?.certifierType).toBe("internal");
		});

		it("changes only the caller's own authorization of a shared certifier", async () => {
			// The type is per purveyor: B's word about this certifier is B's.
			await callerFor(ids.adminA).certifiers.setCertifierType({
				id: certifierShared,
				certifierType: "internal",
			});

			expect(await typeOf(certifierShared, wpA)).toBe("internal");
			expect(await typeOf(certifierShared, wpB)).toBe("external");
		});

		it("lets a SubAdmin move one, and refuses an Employee", async () => {
			await expect(
				callerFor(ids.subAdminA).certifiers.setCertifierType({
					id: certifierA,
					certifierType: "internal",
				}),
			).resolves.toMatchObject({ certifierType: "internal" });

			await expect(
				callerFor(ids.employeeA).certifiers.setCertifierType({
					id: certifierA,
					certifierType: "external",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await typeOf(certifierA, wpA)).toBe("internal");
		});

		it("refuses a certifier id from the other tenant, and leaves the row untouched", async () => {
			await expect(
				callerFor(ids.adminA).certifiers.setCertifierType({
					id: certifierB,
					certifierType: "internal",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(await typeOf(certifierB, wpB)).toBe("external");
		});

		it("accepts only an id and a type", async () => {
			await expect(
				callerFor(ids.adminA).certifiers.setCertifierType({
					id: certifierA,
					certifierType: "internal",
					status: "blocked",
				} as never),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(await typeOf(certifierA, wpA)).toBe("external");
			expect((await statusOf(certifierA)).status).toBe("active");
		});

		it("logs a real change and stays silent on a no-op", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).certifiers.setCertifierType({
				id: certifierA,
				certifierType: "external",
			});
			expect(
				lines.filter((line) => line.event === "certifier_type_changed"),
			).toHaveLength(0);

			await callerFor(ids.adminA).certifiers.setCertifierType({
				id: certifierA,
				certifierType: "internal",
			});
			expect(
				lines.find((line) => line.event === "certifier_type_changed"),
			).toMatchObject({
				certifier_id: certifierA,
				wp_id: wpA,
				from: "external",
				to: "internal",
			});
		});
	});

	describe("a blocked certifier's own access", () => {
		it("is refused everywhere, not just shown as blocked in the WP table", async () => {
			// The acceptance criterion for this feature. `certifiers.status` is not
			// an `auth.users` flag, so the only thing that can turn it into a loss
			// of access is `resolveCaller` — every protected procedure and every
			// server-rendered route goes through it.
			await expect(
				callerFor(ids.certifierAProfile).whoami(),
			).resolves.toMatchObject({ globalRole: "certifier" });

			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			await expect(callerFor(ids.certifierAProfile).whoami()).rejects.toThrow(
				/account blocked/i,
			);
		});

		it("comes back when they are unblocked", async () => {
			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});
			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "active",
			});

			await expect(
				callerFor(ids.certifierAProfile).whoami(),
			).resolves.toMatchObject({ globalRole: "certifier" });
		});

		it("denies the very next request on a session that was already working", async () => {
			// The sequence the product cares about, in order and on one caller: the
			// certifier is signed in and working, a purveyor blocks them mid-session,
			// and the next protected call is refused. Nothing revokes the Supabase
			// session — blocking writes `certifiers.status` and touches nothing in
			// `auth.users` — so the only reason this fails is that every request
			// re-resolves the profile instead of trusting what it resolved before.
			//
			// A single `session` object rather than a fresh caller per step: a new
			// caller each time would prove the lookup works, not that a *held*
			// session stops working.
			const session = callerFor(ids.certifierAProfile);

			await expect(session.whoami()).resolves.toMatchObject({
				globalRole: "certifier",
			});

			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			const refused = await session.whoami().catch((error: unknown) => error);

			const { callerRefusal } = await import("../context");
			expect(callerRefusal(refused)).toBe("blocked");

			// And it stays refused rather than being a one-off.
			await expect(session.whoami()).rejects.toThrow(/account blocked/i);
		});

		it("carries the reason as a value, so the sign-in screen can explain it", async () => {
			// The refusal has to survive the trip through tRPC as something the
			// route gate can branch on. Matching on the message would put the
			// sign-in screen's behaviour at the mercy of a copy edit — and the
			// screen has two refusals to tell apart, because a blocked account and
			// an unfinished one need different advice.
			const { callerRefusal } = await import("../context");

			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			const blocked = await callerFor(ids.certifierAProfile)
				.whoami()
				.catch((error: unknown) => error);

			expect(callerRefusal(blocked)).toBe("blocked");

			// An account with credentials but no profile is the other one, and it
			// must not be reported as a block.
			const stranger = await callerFor(randomUUID())
				.whoami()
				.catch((error: unknown) => error);

			expect(callerRefusal(stranger)).toBe("no_profile");
		});

		it("does not block anybody else", async () => {
			// The certifier check is keyed on the caller's own profile. A blocked
			// row belonging to somebody else must never reach this decision.
			await callerFor(ids.adminA).certifiers.setCertifierStatus({
				id: certifierA,
				status: "blocked",
			});

			await expect(
				callerFor(ids.certifierBProfile).whoami(),
			).resolves.toMatchObject({ globalRole: "certifier" });
			await expect(callerFor(ids.adminA).whoami()).resolves.toMatchObject({
				globalRole: "wp_admin",
			});
		});
	});
});
