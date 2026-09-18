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
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import type { AppRouter } from "./index";

/**
 * The certifier dashboard's procedures against real Postgres: a certifier's
 * own drafts and their own submitted archive, and nobody else's.
 *
 * Two certifiers are seeded, each with a draft and a submitted row, sharing
 * one water purveyor — this router doesn't care which purveyor a row belongs
 * to, only which certifier filed it, so the isolation this suite proves is
 * certifier-to-certifier rather than tenant-to-tenant.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own boundary. The
 * row policies are a second, independent one, covered by the certifier
 * section of `packages/db/src/test-submissions-rls.test.ts`.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

type Certifier = AppRouter["certifier"];
type Inputs = {
	[Procedure in keyof Certifier]: inferProcedureInput<Certifier[Procedure]>;
};
type Outputs = {
	[Procedure in keyof Certifier]: inferProcedureOutput<Certifier[Procedure]>;
};

const wp = randomUUID();
// A second WP certifier A is also (actively) authorized for, and a third
// they hold only a `pending` authorization for — both exist to prove
// `listAuthorizedWps` returns every active WP (not just one) while excluding
// a not-yet-active one, and to prove a WP switch re-filters rather than merges.
const wpSecond = randomUUID();
const wpPending = randomUUID();
const ids = {
	certifierProfileA: randomUUID(),
	certifierProfileB: randomUUID(),
	wpAdmin: randomUUID(),
	superAdmin: randomUUID(),
};
const certifierA = randomUUID();
const certifierB = randomUUID();

/** Rows the whole suite reads and never writes. */
const draftA = randomUUID();
const submittedA = randomUUID();
const draftB = randomUUID();
const submittedB = randomUUID();

let pool: pg.Pool;

let callerFor: (profileId: string) => {
	certifier: {
		listAuthorizedWps: () => Promise<Outputs["listAuthorizedWps"]>;
		listDrafts: (
			input?: Inputs["listDrafts"],
		) => Promise<Outputs["listDrafts"]>;
		listSubmissions: (
			input?: Inputs["listSubmissions"],
		) => Promise<Outputs["listSubmissions"]>;
		getDraft: (input: Inputs["getDraft"]) => Promise<Outputs["getDraft"]>;
		deleteDraft: (
			input: Inputs["deleteDraft"],
		) => Promise<Outputs["deleteDraft"]>;
		getProfile: () => Promise<Outputs["getProfile"]>;
		updateProfile: (
			input: Inputs["updateProfile"],
		) => Promise<Outputs["updateProfile"]>;
	};
};

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

/** Rows this test created, removed after it so the shared fixtures stay clean. */
let created: string[] = [];

async function seedSubmission({
	certifierId,
	status = "draft",
	testDate = null,
	testResult = null,
	currentStep = 1,
	wizardData = { fixtureKey: "certifier-dashboard-fixture" },
	id = randomUUID(),
}: {
	certifierId: string;
	status?: "draft" | "submitted";
	testDate?: string | null;
	testResult?: string | null;
	currentStep?: number | null;
	wizardData?: Record<string, unknown>;
	id?: string;
}) {
	await pool.query(
		`insert into test_submissions
		   (id, certifier_id, water_purveyor_id, status, bfa_type, wizard_data,
		    current_step, test_date, test_result)
		 values ($1, $2, $3, $4::submission_status, 'RP', $5::jsonb, $6, $7, $8::test_result)`,
		[
			id,
			certifierId,
			wp,
			status,
			JSON.stringify(wizardData),
			currentStep,
			testDate,
			testResult,
		],
	);

	created.push(id);
	return id;
}

describeDb("certifier dashboard procedures", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const { t } = await import("../index");
		const { appRouter } = await import("./index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as ReturnType<typeof callerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Certifier Dashboard Fixture Water Works', 'CERT-DASH', 'active'),
			        ($2, 'Certifier Dashboard Fixture Water Works — Second', 'CERT-DASH-2', 'active'),
			        ($3, 'Certifier Dashboard Fixture Water Works — Pending', 'CERT-DASH-3', 'active')`,
			[wp, wpSecond, wpPending],
		);

		const profiles: [string, string | null, string][] = [
			[ids.certifierProfileA, null, "certifier"],
			[ids.certifierProfileB, null, "certifier"],
			[ids.wpAdmin, wp, "wp_admin"],
			[ids.superAdmin, null, "super_admin"],
		];

		for (const [id, wpId, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'Certifier Dashboard Fixture', $3::global_role, 'active')`,
				[id, wpId, role],
			);
		}

		await pool.query(
			`insert into certifiers (id, profile_id, company, id_number, license_expiration_date, status)
			 values ($1, $2, 'Fixture Testing A', 'CERT-A-1', '2029-01-01', 'active'),
			        ($3, $4, 'Fixture Testing B', 'CERT-B-1', '2029-01-01', 'active')`,
			[certifierA, ids.certifierProfileA, certifierB, ids.certifierProfileB],
		);

		// Certifier A is actively authorized for two WPs and only `pending` for a
		// third; certifier B is active for one (the shared `wp`) — enough to
		// prove `listAuthorizedWps` returns every active row (not just the
		// first), excludes a not-yet-active one, and stays certifier-scoped.
		await pool.query(
			`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
			 values ($1, $2, 'active'),
			        ($1, $3, 'active'),
			        ($1, $4, 'pending'),
			        ($5, $2, 'active')`,
			[certifierA, wp, wpSecond, wpPending, certifierB],
		);

		await seedSubmission({
			id: draftA,
			certifierId: certifierA,
			status: "draft",
		});
		await seedSubmission({
			id: submittedA,
			certifierId: certifierA,
			status: "submitted",
			testDate: "2027-05-01",
			testResult: "pass",
		});
		await seedSubmission({
			id: draftB,
			certifierId: certifierB,
			status: "draft",
		});
		await seedSubmission({
			id: submittedB,
			certifierId: certifierB,
			status: "submitted",
			testDate: "2027-05-02",
			testResult: "fail",
		});
		created = [];
	});

	beforeEach(() => {
		created = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();

		if (created.length > 0) {
			await pool.query(
				"delete from test_submissions where id = any($1::uuid[])",
				[created],
			);
			created = [];
		}
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from test_submissions where certifier_id = any($1::uuid[])",
			[[certifierA, certifierB]],
		);
		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id = any($1::uuid[])",
			[[certifierA, certifierB]],
		);
		await pool.query("delete from certifiers where id = any($1::uuid[])", [
			[certifierA, certifierB],
		]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wp, wpSecond, wpPending],
		]);
		await pool.end();
	});

	describe("who may call them at all", () => {
		it("refuses a WP role", async () => {
			await expect(
				callerFor(ids.wpAdmin).certifier.listDrafts({ waterPurveyorId: wp }),
			).rejects.toThrow(/certifier only/i);
		});

		it("refuses a Super-Admin, rather than showing every certifier's rows", async () => {
			await expect(
				callerFor(ids.superAdmin).certifier.listDrafts({
					waterPurveyorId: wp,
				}),
			).rejects.toThrow(/certifier only/i);
		});
	});

	describe("listAuthorizedWps", () => {
		it("returns every active authorization, excluding a pending one", async () => {
			const wps = await callerFor(
				ids.certifierProfileA,
			).certifier.listAuthorizedWps();

			expect(wps.map((row) => row.id).sort()).toEqual([wp, wpSecond].sort());
		});

		it("stays certifier-scoped", async () => {
			const wps = await callerFor(
				ids.certifierProfileB,
			).certifier.listAuthorizedWps();

			expect(wps.map((row) => row.id)).toEqual([wp]);
		});
	});

	describe("a forged or unauthorized water purveyor id", () => {
		it("is refused by listDrafts", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.listDrafts({
					waterPurveyorId: randomUUID(),
				}),
			).rejects.toThrow(/not authorized/i);
		});

		it("is refused by listSubmissions", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.listSubmissions({
					waterPurveyorId: randomUUID(),
				}),
			).rejects.toThrow(/not authorized/i);
		});

		it("is refused by getDraft, even for the caller's own draft", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.getDraft({
					id: draftA,
					waterPurveyorId: randomUUID(),
				}),
			).rejects.toThrow(/not authorized/i);
		});

		it("is refused by deleteDraft, and leaves the draft in place", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.deleteDraft({
					id: draftA,
					waterPurveyorId: randomUUID(),
				}),
			).rejects.toThrow(/not authorized/i);

			const { rows } = await pool.query(
				"select 1 from test_submissions where id = $1",
				[draftA],
			);
			expect(rows).toHaveLength(1);
		});

		it("a pending (not yet active) authorization is refused the same way", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.listDrafts({
					waterPurveyorId: wpPending,
				}),
			).rejects.toThrow(/not authorized/i);
		});
	});

	describe("listDrafts / listSubmissions", () => {
		it("shows two certifiers completely separate draft lists", async () => {
			const fromA = await callerFor(ids.certifierProfileA).certifier.listDrafts(
				{ waterPurveyorId: wp },
			);
			const fromB = await callerFor(ids.certifierProfileB).certifier.listDrafts(
				{ waterPurveyorId: wp },
			);

			expect(fromA.rows.map((row) => row.id)).toContain(draftA);
			expect(fromA.rows.map((row) => row.id)).not.toContain(draftB);
			expect(fromB.rows.map((row) => row.id)).toContain(draftB);
			expect(fromB.rows.map((row) => row.id)).not.toContain(draftA);
		});

		it("shows two certifiers completely separate submitted lists", async () => {
			const fromA = await callerFor(
				ids.certifierProfileA,
			).certifier.listSubmissions({ waterPurveyorId: wp });
			const fromB = await callerFor(
				ids.certifierProfileB,
			).certifier.listSubmissions({ waterPurveyorId: wp });

			expect(fromA.rows.map((row) => row.id)).toContain(submittedA);
			expect(fromA.rows.map((row) => row.id)).not.toContain(submittedB);
			expect(fromB.rows.map((row) => row.id)).toContain(submittedB);
			expect(fromB.rows.map((row) => row.id)).not.toContain(submittedA);
		});

		it("never lists a certifier's draft in their own submitted archive", async () => {
			const page = await callerFor(
				ids.certifierProfileA,
			).certifier.listSubmissions({ waterPurveyorId: wp });

			expect(page.rows.map((row) => row.id)).not.toContain(draftA);
		});

		it("does not show a row filed under a different active WP — switching re-filters, it does not merge", async () => {
			const underWp = await callerFor(
				ids.certifierProfileA,
			).certifier.listDrafts({ waterPurveyorId: wp });
			const underWpSecond = await callerFor(
				ids.certifierProfileA,
			).certifier.listDrafts({ waterPurveyorId: wpSecond });

			expect(underWp.rows.map((row) => row.id)).toContain(draftA);
			expect(underWpSecond.rows.map((row) => row.id)).not.toContain(draftA);
			expect(underWpSecond.rows).toHaveLength(0);
		});

		it("orders drafts by most recently saved first", async () => {
			const older = await seedSubmission({ certifierId: certifierA });
			await pool.query(
				"update test_submissions set updated_at = now() - interval '1 day' where id = $1",
				[older],
			);
			const newer = await seedSubmission({ certifierId: certifierA });

			const page = await callerFor(ids.certifierProfileA).certifier.listDrafts({
				page: 1,
				pageSize: 100,
				waterPurveyorId: wp,
			});
			const order = page.rows.map((row) => row.id);

			expect(order.indexOf(newer)).toBeLessThan(order.indexOf(older));
		});

		it("pages without repeating or skipping a row", async () => {
			for (let i = 0; i < 3; i++) {
				await seedSubmission({ certifierId: certifierA });
			}

			const first = await callerFor(ids.certifierProfileA).certifier.listDrafts(
				{
					page: 1,
					pageSize: 2,
					waterPurveyorId: wp,
				},
			);
			const second = await callerFor(
				ids.certifierProfileA,
			).certifier.listDrafts({
				page: 2,
				pageSize: 2,
				waterPurveyorId: wp,
			});

			expect(first.rows).toHaveLength(2);
			expect(
				first.rows.map((row) => row.id).includes(second.rows[0]?.id ?? ""),
			).toBe(false);
		});
	});

	describe("getDraft", () => {
		it("returns one of the caller's own drafts", async () => {
			const row = await callerFor(ids.certifierProfileA).certifier.getDraft({
				id: draftA,
				waterPurveyorId: wp,
			});

			expect(row.id).toBe(draftA);
		});

		it("refuses another certifier's draft without saying it exists", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.getDraft({
					id: draftB,
					waterPurveyorId: wp,
				}),
			).rejects.toThrow(/draft not found/i);
		});

		it("refuses the caller's own submitted row, with the same message", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.getDraft({
					id: submittedA,
					waterPurveyorId: wp,
				}),
			).rejects.toThrow(/draft not found/i);
		});

		it("gives the same refusal for an id that never existed", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.getDraft({
					id: randomUUID(),
					waterPurveyorId: wp,
				}),
			).rejects.toThrow(/draft not found/i);
		});
	});

	describe("deleteDraft", () => {
		it("deletes one of the caller's own drafts", async () => {
			const target = await seedSubmission({ certifierId: certifierA });

			await callerFor(ids.certifierProfileA).certifier.deleteDraft({
				id: target,
				waterPurveyorId: wp,
			});

			const { rows } = await pool.query(
				"select 1 from test_submissions where id = $1",
				[target],
			);
			expect(rows).toHaveLength(0);
		});

		it("refuses another certifier's draft, and leaves it in place", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.deleteDraft({
					id: draftB,
					waterPurveyorId: wp,
				}),
			).rejects.toThrow(/draft not found/i);

			const { rows } = await pool.query(
				"select 1 from test_submissions where id = $1",
				[draftB],
			);
			expect(rows).toHaveLength(1);
		});

		it("refuses the caller's own submitted row", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifier.deleteDraft({
					id: submittedA,
					waterPurveyorId: wp,
				}),
			).rejects.toThrow(/draft not found/i);

			const { rows } = await pool.query(
				"select 1 from test_submissions where id = $1",
				[submittedA],
			);
			expect(rows).toHaveLength(1);
		});

		it("emits a structured audit line naming the actor and the certifier", async () => {
			const target = await seedSubmission({ certifierId: certifierA });
			const lines = captureLogs();

			await callerFor(ids.certifierProfileA).certifier.deleteDraft({
				id: target,
				waterPurveyorId: wp,
			});

			expect(
				lines.find((line) => line.event === "draft_deleted"),
			).toMatchObject({
				actor_id: ids.certifierProfileA,
				certifier_id: certifierA,
				submission_id: target,
			});
		});
	});

	describe("updateProfile", () => {
		it("writes to both profiles and certifiers in one call", async () => {
			const updated = await callerFor(
				ids.certifierProfileA,
			).certifier.updateProfile({
				fullName: "Updated Name",
				company: "Updated Co",
				idNumber: "CERT-A-1",
				licenseExpirationDate: "2029-01-01",
			});

			expect(updated).toMatchObject({
				fullName: "Updated Name",
				company: "Updated Co",
			});

			// Restore the fixture's own values so later tests in this file are not
			// order-dependent on this one having run.
			await callerFor(ids.certifierProfileA).certifier.updateProfile({
				fullName: "Certifier Dashboard Fixture",
				company: "Fixture Testing A",
				idNumber: "CERT-A-1",
				licenseExpirationDate: "2029-01-01",
			});
		});

		it("treats a save that changes nothing as no edit at all", async () => {
			const before = await callerFor(
				ids.certifierProfileA,
			).certifier.getProfile();
			const lines = captureLogs();

			await callerFor(ids.certifierProfileA).certifier.updateProfile({
				// All four are required inputs now; `getProfile`'s own shape stays
				// nullable (an account that never opened this form has no value
				// yet), and the fixture always seeds one — these are never null here.
				fullName: before.fullName as string,
				company: before.company as string,
				idNumber: before.idNumber as string,
				licenseExpirationDate: before.licenseExpirationDate as string,
			});

			expect(
				lines.find((line) => line.event === "profile_updated"),
			).toBeUndefined();
		});

		it("emits a structured audit line naming the changed fields", async () => {
			const lines = captureLogs();

			await callerFor(ids.certifierProfileA).certifier.updateProfile({
				fullName: "Certifier Dashboard Fixture",
				company: "Renamed For Audit Test",
				idNumber: "CERT-A-1",
				licenseExpirationDate: "2029-01-01",
			});

			expect(
				lines.find((line) => line.event === "profile_updated"),
			).toMatchObject({
				actor_id: ids.certifierProfileA,
				certifier_id: certifierA,
				changed_fields: ["company"],
			});

			// Restore.
			await callerFor(ids.certifierProfileA).certifier.updateProfile({
				fullName: "Certifier Dashboard Fixture",
				company: "Fixture Testing A",
				idNumber: "CERT-A-1",
				licenseExpirationDate: "2029-01-01",
			});
		});
	});
});
