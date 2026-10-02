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
 * The submitted-test procedures against real Postgres: who may call them, what
 * they can see, and — the part that matters — what happens when a caller names
 * a submission, a draft or an asset belonging to somebody else.
 *
 * Two purveyors are seeded with deliberately interchangeable submissions: the
 * same certifier, the same typed BIN, the same day, in both tenants. A leak
 * between them has to look like a leak, not like a plausible row. One certifier
 * files into both, which is the normal case on this platform and the reason a
 * submission's tenancy cannot be read through the certifier who filed it.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary and have their own suite
 * in `packages/db/src/test-submissions-rls.test.ts`.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

/**
 * The procedures' own input and output types, taken one at a time rather than
 * through `inferRouterInputs`/`inferRouterOutputs` — those describe what travels
 * over HTTP, where a `timestamp` has already been serialised to a string, and a
 * `createCaller` caller returns `Date` objects.
 */
type SubmittedTests = AppRouter["submittedTests"];
type Inputs = {
	[Procedure in keyof SubmittedTests]: inferProcedureInput<
		SubmittedTests[Procedure]
	>;
};
type Outputs = {
	[Procedure in keyof SubmittedTests]: inferProcedureOutput<
		SubmittedTests[Procedure]
	>;
};

const wpA = randomUUID();
const wpB = randomUUID();
const ids = {
	adminA: randomUUID(),
	subAdminA: randomUUID(),
	employeeA: randomUUID(),
	adminB: randomUUID(),
	certifierProfileA: randomUUID(),
	superAdmin: randomUUID(),
	orphanedWpAdmin: randomUUID(),
};
const certifierA = randomUUID();
const assetA = randomUUID();
const assetB = randomUUID();

/** Rows the whole suite reads and never writes. */
const submittedA = randomUUID();
const submittedB = randomUUID();
const draftA = randomUUID();

let pool: pg.Pool;

let callerFor: (profileId: string) => {
	submittedTests: {
		listSubmittedTests: (
			input?: Inputs["listSubmittedTests"],
		) => Promise<Outputs["listSubmittedTests"]>;
		exportSubmittedTests: (
			input: Inputs["exportSubmittedTests"],
		) => Promise<Outputs["exportSubmittedTests"]>;
		getSubmittedTest: (
			input: Inputs["getSubmittedTest"],
		) => Promise<Outputs["getSubmittedTest"]>;
		updateSubmittedTest: (
			input: Inputs["updateSubmittedTest"],
		) => Promise<Outputs["updateSubmittedTest"]>;
		linkSubmissionAsset: (
			input: Inputs["linkSubmissionAsset"],
		) => Promise<Outputs["linkSubmissionAsset"]>;
	};
	/**
	 * The asset procedures, reached from here for one assertion only: that a
	 * cross-tenant *link* being refused does not quarantine the asset itself from
	 * the purveyor that legitimately owns it.
	 */
	assets: {
		getAsset: (
			input: inferProcedureInput<AppRouter["assets"]["getAsset"]>,
		) => Promise<inferProcedureOutput<AppRouter["assets"]["getAsset"]>>;
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

/**
 * Inserts one submission directly.
 *
 * Through SQL rather than a procedure because there is no procedure that makes
 * one: a submission is the certifier wizard's to create (§ 6.5, week 4), and
 * this router deliberately has no insert. So the fixtures arrive the way the
 * wizard's rows will.
 */
async function seedSubmission({
	waterPurveyorId,
	status = "submitted",
	bfaAssetId = null,
	bfaType = "RP",
	testDate = "2027-04-01",
	testResult = "pass",
	submittedBinText = null,
	wizardData = { fixtureKey: "submission-fixture" },
	overriddenFields = null,
	id = randomUUID(),
}: {
	waterPurveyorId: string;
	status?: string;
	bfaAssetId?: string | null;
	bfaType?: string;
	testDate?: string | null;
	testResult?: string | null;
	submittedBinText?: string | null;
	wizardData?: Record<string, unknown>;
	overriddenFields?: string[] | null;
	id?: string;
}) {
	await pool.query(
		`insert into test_submissions
		   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
		    wizard_data, overridden_fields, submitted_bin_text, test_date, test_result)
		 values ($1, $2, $3, $4, $5::submission_status, $6::bfa_type, $7::jsonb, $8::jsonb, $9, $10, $11::test_result)`,
		[
			id,
			bfaAssetId,
			certifierA,
			waterPurveyorId,
			status,
			bfaType,
			JSON.stringify(wizardData),
			overriddenFields ? JSON.stringify(overriddenFields) : null,
			submittedBinText,
			testDate,
			testResult,
		],
	);

	created.push(id);

	return id;
}

/** The whole record, as the document view sends it. */
function asCorrection(
	row: Outputs["getSubmittedTest"],
	overrides: Partial<Inputs["updateSubmittedTest"]> = {},
): Inputs["updateSubmittedTest"] {
	return {
		id: row.id,
		bfaType: row.bfaType,
		submittedBinText: row.submittedBinText,
		testDate: row.testDate,
		testResult: row.testResult,
		signatureMethod: row.signatureMethod,
		signatureData: row.signatureData,
		wizardData: row.wizardData as Record<string, string>,
		...overrides,
	};
}

describeDb("submitted-test procedures", () => {
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
			 values ($1, 'Submission Fixture Water Works', 'SUB-A', 'active'),
			        ($2, 'Submission Fixture Water Works', 'SUB-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string][] = [
			[ids.adminA, wpA, "wp_admin"],
			[ids.subAdminA, wpA, "wp_sub_admin"],
			[ids.employeeA, wpA, "wp_employee"],
			[ids.adminB, wpB, "wp_admin"],
			[ids.certifierProfileA, null, "certifier"],
			[ids.superAdmin, null, "super_admin"],
			// A WP role with no purveyor on the row — the broken state
			// `wpProcedure` refuses rather than running an unscoped query for.
			[ids.orphanedWpAdmin, null, "wp_admin"],
		];

		for (const [id, wp, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'Submission Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}

		await pool.query(
			`insert into certifiers (id, profile_id, company, status)
			 values ($1, $2, 'Fixture Backflow Testing', 'active')`,
			[certifierA, ids.certifierProfileA],
		);

		await pool.query(
			`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date)
			 values ($1, $2, 'SHARED-SUB-BIN', 'RP', '1 Shared Way', '2027-01-15'),
			        ($3, $4, 'SHARED-SUB-BIN', 'RP', '1 Shared Way', '2027-01-15')`,
			[assetA, wpA, assetB, wpB],
		);

		// The three rows the whole suite reads. Created here rather than per test
		// so the cross-tenant pair is genuinely interchangeable.
		await seedSubmission({
			id: submittedA,
			waterPurveyorId: wpA,
			bfaAssetId: assetA,
			submittedBinText: "SHARED-SUB-BIN",
		});
		await seedSubmission({
			id: submittedB,
			waterPurveyorId: wpB,
			bfaAssetId: assetB,
			submittedBinText: "SHARED-SUB-BIN",
		});
		await seedSubmission({
			id: draftA,
			waterPurveyorId: wpA,
			bfaAssetId: assetA,
			status: "draft",
			testDate: null,
			testResult: null,
		});
		// Kept out of the per-test cleanup: these are the suite's own fixtures.
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
			"delete from test_submissions where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
		await pool.query(
			"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
		await pool.query("delete from certifiers where id = $1", [certifierA]);
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
				callerFor(ids.certifierProfileA).submittedTests.listSubmittedTests(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a Super-Admin, rather than showing every tenant's tests", async () => {
			await expect(
				callerFor(ids.superAdmin).submittedTests.listSubmittedTests(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			await expect(
				callerFor(ids.orphanedWpAdmin).submittedTests.listSubmittedTests(),
			).rejects.toThrow(/no water purveyor/i);
		});

		it("lets all three WP roles read the list", async () => {
			// The confirmed half of the permission question: every WP role views
			// submitted tests. Only correcting one is narrowed.
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const page =
					await callerFor(reader).submittedTests.listSubmittedTests();

				expect(page.rows.map((row) => row.id)).toContain(submittedA);
			}
		});

		it("refuses a WP Employee correcting a test", async () => {
			const row = await callerFor(
				ids.employeeA,
			).submittedTests.getSubmittedTest({ id: submittedA });

			await expect(
				callerFor(ids.employeeA).submittedTests.updateSubmittedTest(
					asCorrection(row, { testResult: "fail" }),
				),
			).rejects.toThrow(/admin or subadmin/i);
		});

		it("refuses a WP Employee linking an asset", async () => {
			const unresolved = await seedSubmission({ waterPurveyorId: wpA });

			await expect(
				callerFor(ids.employeeA).submittedTests.linkSubmissionAsset({
					submissionId: unresolved,
					assetId: assetA,
				}),
			).rejects.toThrow(/admin or subadmin/i);
		});
	});

	describe("listSubmittedTests", () => {
		it("shows two purveyors completely separate lists", async () => {
			const fromA = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });
			const fromB = await callerFor(
				ids.adminB,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });

			const idsFromA = fromA.rows.map((row) => row.id);
			const idsFromB = fromB.rows.map((row) => row.id);

			expect(idsFromA).toContain(submittedA);
			expect(idsFromA).not.toContain(submittedB);
			expect(idsFromB).toContain(submittedB);
			expect(idsFromB).not.toContain(submittedA);
		});

		it("never lists a draft", async () => {
			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });

			expect(page.rows.map((row) => row.id)).not.toContain(draftA);
		});

		it("counts only the caller's own tenant's submitted rows", async () => {
			const { total } = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				page: 1,
				pageSize: 100,
			});

			const { rows } = await pool.query(
				"select count(*)::int as value from test_submissions where water_purveyor_id = $1 and status = 'submitted'",
				[wpA],
			);

			expect(total).toBe(rows[0]?.value);
		});

		it("carries the certifier's name across certifiers", async () => {
			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });

			expect(
				page.rows.find((row) => row.id === submittedA)?.certifierName,
			).toBe("Submission Fixture");
		});

		it("keeps an unresolved submission in the list rather than joining it away", async () => {
			// The left join is the point: a submission with no asset is precisely
			// the row this screen exists to surface.
			const unresolved = await seedSubmission({
				waterPurveyorId: wpA,
				submittedBinText: "TYPED-ONLY",
			});

			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });
			const row = page.rows.find((candidate) => candidate.id === unresolved);

			expect(row).toMatchObject({ bin: null, submittedBinText: "TYPED-ONLY" });
		});

		it("filters by result", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				testResult: "fail",
				testDate: "2029-06-02",
			});

			const failures = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				page: 1,
				pageSize: 100,
				result: "fail",
				from: "2029-06-01",
				to: "2029-06-30",
			});

			expect(failures.rows).toHaveLength(1);
			expect(failures.rows[0]?.testResult).toBe("fail");
		});

		it("includes both ends of the date range", async () => {
			const first = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-03-01",
			});
			const last = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-03-31",
			});
			await seedSubmission({ waterPurveyorId: wpA, testDate: "2029-04-01" });

			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				page: 1,
				pageSize: 100,
				from: "2029-03-01",
				to: "2029-03-31",
			});

			expect(page.rows.map((row) => row.id).sort()).toEqual(
				[first, last].sort(),
			);
		});

		it("narrows by result and range together rather than one replacing the other", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-08-10",
				testResult: "pass",
			});
			const target = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-08-11",
				testResult: "fail",
			});

			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				page: 1,
				pageSize: 100,
				result: "fail",
				from: "2029-08-01",
				to: "2029-08-31",
			});

			expect(page.rows.map((row) => row.id)).toEqual([target]);
		});

		it("orders newest test date first", async () => {
			const older = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-01-05",
			});
			const newer = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-01-09",
			});

			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				page: 1,
				pageSize: 100,
				from: "2029-01-01",
				to: "2029-01-31",
			});

			expect(page.rows.map((row) => row.id)).toEqual([newer, older]);
		});

		it("sorts a submission with no test date last rather than ahead of everything", async () => {
			const dated = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2029-11-02",
			});
			const undated = await seedSubmission({
				waterPurveyorId: wpA,
				testDate: null,
			});

			const page = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });
			const order = page.rows.map((row) => row.id);

			expect(order.indexOf(dated)).toBeLessThan(order.indexOf(undated));
		});

		it("pages without repeating or skipping a row", async () => {
			for (const day of ["01", "02", "03"]) {
				await seedSubmission({
					waterPurveyorId: wpA,
					testDate: `2029-09-${day}`,
				});
			}

			const range = { from: "2029-09-01", to: "2029-09-30" };
			const first = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 2, ...range });
			const second = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				page: 2,
				pageSize: 2,
				...range,
			});

			expect(first.rows).toHaveLength(2);
			expect(second.rows).toHaveLength(1);
			// The whole filtered size, not the page's — a pager that says "page 1
			// of 2" needs it.
			expect(first.total).toBe(3);
			expect(first.pageCount).toBe(2);
			expect(
				first.rows.map((row) => row.id).includes(second.rows[0]?.id ?? ""),
			).toBe(false);
		});
	});

	/**
	 * A submission in one purveyor whose `bfa_asset_id` points at another
	 * purveyor's asset.
	 *
	 * Not a state any procedure can produce — `linkSubmissionAsset` refuses it,
	 * and `0009_test_submission_asset_tenancy` put the same clause in the row
	 * policy's WITH CHECK. It is seeded here directly, with SQL, because the
	 * question is what the *read* path does when it meets one anyway: corruption,
	 * a restore, or a row written before those two rules existed.
	 *
	 * `0009` deliberately left the clause out of USING so such a row stays
	 * reachable and repairable. That makes the read side's job specific: keep the
	 * submission visible to the purveyor who owns it, and do not carry the
	 * foreign asset's fields along with it.
	 *
	 * The foreign asset is given values that exist nowhere else in the fixture,
	 * so a leak cannot be mistaken for a plausible row.
	 */
	describe("a submission whose asset link crosses tenants", () => {
		const foreignAsset = randomUUID();
		const crossLinked = randomUUID();

		beforeAll(async () => {
			await pool.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date)
				 values ($1, $2, 'LEAK-CANARY-BIN', 'DC', '99 Foreign Street', '2027-06-01')`,
				[foreignAsset, wpB],
			);

			// Straight to SQL: no procedure will make this link, which is the point.
			await pool.query(
				`insert into test_submissions
				   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
				    wizard_data, submitted_bin_text, test_date, test_result)
				 values ($1, $2, $3, $4, 'submitted', 'RP', $5::jsonb, 'TYPED-BY-CERTIFIER', '2027-04-02', 'pass')`,
				[
					crossLinked,
					foreignAsset,
					certifierA,
					wpA,
					JSON.stringify({ fixtureKey: "cross-tenant-link" }),
				],
			);
		});

		afterAll(async () => {
			await pool.query("delete from test_submissions where id = $1", [
				crossLinked,
			]);
			await pool.query("delete from bfa_assets where id = $1", [foreignAsset]);
		});

		it("still lists the row for the purveyor that owns the submission", async () => {
			const { rows } = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });

			// Visible, not filtered away. Dropping it would hide the one row
			// somebody has to go and repair.
			expect(rows.map((row) => row.id)).toContain(crossLinked);
		});

		it("carries none of the foreign asset's fields on the listed row", async () => {
			const { rows } = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });
			const row = rows.find((candidate) => candidate.id === crossLinked);

			expect(row?.bin).toBeNull();
			expect(row?.serviceAddress).toBeNull();
			expect(JSON.stringify(row)).not.toContain("LEAK-CANARY-BIN");
			expect(JSON.stringify(row)).not.toContain("99 Foreign Street");
		});

		it("reads on the list exactly as an unlinked submission does", async () => {
			const { rows } = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });
			const row = rows.find((candidate) => candidate.id === crossLinked);

			// Null BIN plus the certifier's typed text is the shape both screens
			// already render as "not linked to an asset" — so the failure mode is a
			// state the UI has copy for, rather than a blank.
			expect(row?.submittedBinText).toBe("TYPED-BY-CERTIFIER");
		});

		it("opens on the detail path with the foreign asset withheld", async () => {
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: crossLinked,
			});

			expect(row.id).toBe(crossLinked);
			expect(row.bin).toBeNull();
			expect(row.serviceAddress).toBeNull();
			expect(JSON.stringify(row)).not.toContain("LEAK-CANARY-BIN");
			expect(JSON.stringify(row)).not.toContain("99 Foreign Street");
		});

		it("stays invisible to the purveyor whose asset it points at", async () => {
			const { rows } = await callerFor(
				ids.adminB,
			).submittedTests.listSubmittedTests({ page: 1, pageSize: 100 });

			expect(rows.map((row) => row.id)).not.toContain(crossLinked);

			// And by id, not merely unlisted: the submission's own tenant is what
			// scopes it, and B does not own it whatever its asset says.
			await expect(
				callerFor(ids.adminB).submittedTests.getSubmittedTest({
					id: crossLinked,
				}),
			).rejects.toThrow(/not found/i);
		});

		it("leaves the foreign asset reachable to the purveyor that owns it", async () => {
			// The asset is not the problem and is not quarantined — only the link
			// from another tenant's submission is refused.
			const found = await callerFor(ids.adminB).assets.getAsset({
				id: foreignAsset,
			});

			expect(found.asset.bin).toBe("LEAK-CANARY-BIN");
		});
	});

	describe("getSubmittedTest", () => {
		it("returns one submitted test in the caller's own purveyor", async () => {
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: submittedA,
			});

			expect(row).toMatchObject({ id: submittedA, bin: "SHARED-SUB-BIN" });
		});

		it("refuses the other tenant's submission without saying it exists", async () => {
			await expect(
				callerFor(ids.adminA).submittedTests.getSubmittedTest({
					id: submittedB,
				}),
			).rejects.toThrow(/submitted test not found/i);
		});

		it("refuses a draft in the caller's own purveyor, with the same message", async () => {
			// A message that distinguished a draft from a missing row would confirm
			// the row exists, which is the one fact a probe is after.
			await expect(
				callerFor(ids.adminA).submittedTests.getSubmittedTest({ id: draftA }),
			).rejects.toThrow(/submitted test not found/i);
		});

		it("gives the same refusal for an id that never existed", async () => {
			await expect(
				callerFor(ids.adminA).submittedTests.getSubmittedTest({
					id: randomUUID(),
				}),
			).rejects.toThrow(/submitted test not found/i);
		});

		it("returns the certifier's overridden-field marker so the WP can see it", async () => {
			const flagged = await seedSubmission({
				waterPurveyorId: wpA,
				overriddenFields: ["linePressure"],
			});

			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: flagged,
			});

			expect(row.overriddenFields).toEqual(["linePressure"]);
		});
	});

	describe("updateSubmittedTest", () => {
		it("corrects a test in the caller's own purveyor", async () => {
			const target = await seedSubmission({ waterPurveyorId: wpA });
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: target,
			});

			const updated = await callerFor(
				ids.adminA,
			).submittedTests.updateSubmittedTest(
				asCorrection(row, { testResult: "fail", testDate: "2028-02-02" }),
			);

			expect(updated).toMatchObject({
				testResult: "fail",
				testDate: "2028-02-02",
			});
		});

		it("corrects a wizard answer, which is the field set the wizard owns", async () => {
			const target = await seedSubmission({
				waterPurveyorId: wpA,
				wizardData: { linePressure: 58, reliefValveOpened: true },
			});
			const row = await callerFor(
				ids.subAdminA,
			).submittedTests.getSubmittedTest({ id: target });

			const updated = await callerFor(
				ids.subAdminA,
			).submittedTests.updateSubmittedTest(
				asCorrection(row, {
					wizardData: { linePressure: 62, reliefValveOpened: true },
				}),
			);

			expect(updated.wizardData).toEqual({
				linePressure: 62,
				reliefValveOpened: true,
			});
		});

		it("records the caller as the person who corrected it", async () => {
			const target = await seedSubmission({ waterPurveyorId: wpA });
			const row = await callerFor(
				ids.subAdminA,
			).submittedTests.getSubmittedTest({ id: target });

			const updated = await callerFor(
				ids.subAdminA,
			).submittedTests.updateSubmittedTest(
				asCorrection(row, { testResult: "fail" }),
			);

			expect(updated.editedByWpProfileId).toBe(ids.subAdminA);
		});

		it("ignores an actor, a tenant and a status sent by the client", async () => {
			const target = await seedSubmission({ waterPurveyorId: wpA });
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: target,
			});

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest({
				...asCorrection(row, { testResult: "fail" }),
				// Not part of the input shape — the cast is the point: even a client
				// that sends them gets its own tenant, its own attribution and no
				// change of status.
				editedByWpProfileId: ids.employeeA,
				waterPurveyorId: wpB,
				status: "draft",
			} as unknown as Inputs["updateSubmittedTest"]);

			const { rows } = await pool.query(
				"select water_purveyor_id, status, edited_by_wp_profile_id from test_submissions where id = $1",
				[target],
			);

			expect(rows[0]).toMatchObject({
				water_purveyor_id: wpA,
				status: "submitted",
				edited_by_wp_profile_id: ids.adminA,
			});
		});

		it("refuses a submission id from the other tenant, and leaves the row untouched", async () => {
			const foreign = await callerFor(
				ids.adminB,
			).submittedTests.getSubmittedTest({ id: submittedB });

			await expect(
				callerFor(ids.adminA).submittedTests.updateSubmittedTest(
					asCorrection(foreign, { testResult: "fail" }),
				),
			).rejects.toThrow(/submitted test not found/i);

			const { rows } = await pool.query(
				"select test_result, edited_by_wp_profile_id from test_submissions where id = $1",
				[submittedB],
			);

			expect(rows[0]).toMatchObject({
				test_result: "pass",
				edited_by_wp_profile_id: null,
			});
		});

		it("refuses a draft, and leaves it a draft", async () => {
			await expect(
				callerFor(ids.adminA).submittedTests.updateSubmittedTest({
					id: draftA,
					bfaType: "RP",
					submittedBinText: null,
					testDate: null,
					testResult: "pass",
					signatureMethod: null,
					signatureData: null,
					wizardData: {},
				}),
			).rejects.toThrow(/submitted test not found/i);

			const { rows } = await pool.query(
				"select status, test_result from test_submissions where id = $1",
				[draftA],
			);

			expect(rows[0]).toMatchObject({ status: "draft", test_result: null });
		});

		it("emits a structured audit line naming the actor, tenant and changed fields", async () => {
			const target = await seedSubmission({ waterPurveyorId: wpA });
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: target,
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				asCorrection(row, { testResult: "fail", submittedBinText: "HRB-9" }),
			);

			const entry = lines.find(
				(line) => line.event === "test_submission_corrected",
			);

			expect(entry).toMatchObject({
				event: "test_submission_corrected",
				actor_id: ids.adminA,
				submission_id: target,
				wp_id: wpA,
				certifier_id: certifierA,
			});
			expect([...((entry?.changed_fields as string[]) ?? [])].sort()).toEqual([
				"submittedBinText",
				"testResult",
			]);
			expect(typeof entry?.timestamp).toBe("string");
		});

		it("logs which fields changed and never what they changed to", async () => {
			// The audit stream is greppable by tenant. A signature image or a
			// customer's details have no business in it.
			const target = await seedSubmission({ waterPurveyorId: wpA });
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: target,
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).submittedTests.updateSubmittedTest(
				asCorrection(row, { signatureData: "data:image/png;base64,SECRET" }),
			);

			const entry = lines.find(
				(line) => line.event === "test_submission_corrected",
			);

			expect(entry?.changed_fields).toEqual(["signatureData"]);
			expect(JSON.stringify(entry)).not.toContain("SECRET");
		});

		it("treats a save that changes nothing as no edit at all", async () => {
			// `updated_at` would come to mean "when somebody last pressed save", and
			// the attribution would name the last person to have looked at the test.
			const target = await seedSubmission({ waterPurveyorId: wpA });
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: target,
			});

			const lines = captureLogs();

			const result = await callerFor(
				ids.adminA,
			).submittedTests.updateSubmittedTest(asCorrection(row));

			expect(result.editedByWpProfileId).toBeNull();
			expect(result.updatedAt).toEqual(row.updatedAt);
			expect(
				lines.find((line) => line.event === "test_submission_corrected"),
			).toBeUndefined();
		});

		it("treats a wizard bag whose keys only reordered as unchanged", async () => {
			const target = await seedSubmission({
				waterPurveyorId: wpA,
				wizardData: { alpha: 1, beta: 2 },
			});
			const row = await callerFor(ids.adminA).submittedTests.getSubmittedTest({
				id: target,
			});

			const result = await callerFor(
				ids.adminA,
			).submittedTests.updateSubmittedTest(
				asCorrection(row, {
					wizardData: { beta: 2, alpha: 1 } as unknown as Record<
						string,
						string
					>,
				}),
			);

			expect(result.editedByWpProfileId).toBeNull();
		});
	});

	describe("linkSubmissionAsset", () => {
		it("attaches an asset in the caller's own purveyor", async () => {
			const unresolved = await seedSubmission({
				waterPurveyorId: wpA,
				submittedBinText: "HRB-?? 0142",
			});

			const linked = await callerFor(
				ids.adminA,
			).submittedTests.linkSubmissionAsset({
				submissionId: unresolved,
				assetId: assetA,
			});

			expect(linked).toMatchObject({
				bfaAssetId: assetA,
				bin: "SHARED-SUB-BIN",
				// What the certifier typed is kept, not overwritten by the BIN it
				// resolved to. It records what was written on the day.
				submittedBinText: "HRB-?? 0142",
			});
		});

		it("records the caller as the person who resolved it", async () => {
			const unresolved = await seedSubmission({ waterPurveyorId: wpA });

			const linked = await callerFor(
				ids.subAdminA,
			).submittedTests.linkSubmissionAsset({
				submissionId: unresolved,
				assetId: assetA,
			});

			expect(linked.editedByWpProfileId).toBe(ids.subAdminA);
		});

		it("refuses an asset belonging to another purveyor", async () => {
			const unresolved = await seedSubmission({ waterPurveyorId: wpA });

			await expect(
				callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
					submissionId: unresolved,
					assetId: assetB,
				}),
			).rejects.toThrow(/no asset with that id in this water purveyor/i);

			const { rows } = await pool.query(
				"select bfa_asset_id from test_submissions where id = $1",
				[unresolved],
			);

			expect(rows[0]?.bfa_asset_id).toBeNull();
		});

		it("refuses a submission belonging to another purveyor", async () => {
			await expect(
				callerFor(ids.adminB).submittedTests.linkSubmissionAsset({
					submissionId: submittedA,
					assetId: assetB,
				}),
			).rejects.toThrow(/submitted test not found/i);
		});

		it("refuses a draft", async () => {
			await expect(
				callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
					submissionId: draftA,
					assetId: assetA,
				}),
			).rejects.toThrow(/submitted test not found/i);
		});

		it("refuses a submission that already resolved to an asset", async () => {
			// Changing an existing link is a different act from making a missing
			// one — the BIN is the single most protected value in a submission.
			await expect(
				callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
					submissionId: submittedA,
					assetId: assetA,
				}),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		});

		it("emits a structured audit line carrying both BINs", async () => {
			const unresolved = await seedSubmission({
				waterPurveyorId: wpA,
				submittedBinText: "HRB-?? 0142",
			});

			const lines = captureLogs();

			await callerFor(ids.adminA).submittedTests.linkSubmissionAsset({
				submissionId: unresolved,
				assetId: assetA,
			});

			expect(
				lines.find((line) => line.event === "test_submission_asset_linked"),
			).toMatchObject({
				actor_id: ids.adminA,
				submission_id: unresolved,
				wp_id: wpA,
				bfa_asset_id: assetA,
				bin: "SHARED-SUB-BIN",
				submitted_bin_text: "HRB-?? 0142",
			});
		});
	});

	describe("exportSubmittedTests", () => {
		/**
		 * One asset in each tenant with its own occupancy history, so "which
		 * customer does a statement line name" has a real answer to get wrong.
		 *
		 * `historyAsset` changed hands on 2030-06-15: Old Owner through that day,
		 * New Owner from it. It was unoccupied before 2030-01-01.
		 * `noHistoryAsset` has a current customer and no history rows at all.
		 */
		const historyAsset = randomUUID();
		const noHistoryAsset = randomUUID();
		const foreignHistoryAsset = randomUUID();
		const oldOwner = randomUUID();
		const newOwner = randomUUID();
		const pointerOnly = randomUUID();
		const foreignCustomer = randomUUID();

		beforeAll(async () => {
			await pool.query(
				`insert into customers (id, water_purveyor_id, name, email)
				 values ($1, $5, 'Old Owner', 'old-owner@statement.test'),
				        ($2, $5, 'New Owner', 'new-owner@statement.test'),
				        ($3, $5, 'Pointer Only', 'pointer-only@statement.test'),
				        ($4, $6, 'Foreign Customer', 'foreign@statement.test')`,
				[oldOwner, newOwner, pointerOnly, foreignCustomer, wpA, wpB],
			);
			await pool.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address, annual_test_date, current_customer_id)
				 values ($1, $4, 'STMT-HISTORY', 'DC', '5 History Ln', '2030-01-15', $5),
				        ($2, $4, 'STMT-POINTER', 'PVB', '6 Pointer Pl', '2030-01-15', $6),
				        ($3, $7, 'STMT-FOREIGN', 'DC', '7 Foreign Ave', '2030-01-15', $8)`,
				[
					historyAsset,
					noHistoryAsset,
					foreignHistoryAsset,
					wpA,
					newOwner,
					pointerOnly,
					wpB,
					foreignCustomer,
				],
			);
			await pool.query(
				`insert into customer_assignments (bfa_asset_id, customer_id, start_date, end_date)
				 values ($1, $2, '2030-01-01', '2030-06-15'),
				        ($1, $3, '2030-06-15', null),
				        ($4, $5, '2030-01-01', null)`,
				[
					historyAsset,
					oldOwner,
					newOwner,
					foreignHistoryAsset,
					foreignCustomer,
				],
			);
		});

		afterAll(async () => {
			const assets = [historyAsset, noHistoryAsset, foreignHistoryAsset];
			await pool.query(
				"delete from customer_assignments where bfa_asset_id = any($1::uuid[])",
				[assets],
			);
			await pool.query(
				"delete from test_submissions where bfa_asset_id = any($1::uuid[])",
				[assets],
			);
			await pool.query("delete from bfa_assets where id = any($1::uuid[])", [
				assets,
			]);
			await pool.query("delete from customers where id = any($1::uuid[])", [
				[oldOwner, newOwner, pointerOnly, foreignCustomer],
			]);
		});

		async function exportFor(
			profileId: string,
			input: Inputs["exportSubmittedTests"],
		) {
			return callerFor(profileId).submittedTests.exportSubmittedTests(input);
		}

		it("lets all three WP roles export", async () => {
			for (const profileId of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				await expect(exportFor(profileId, {})).resolves.toBeInstanceOf(Array);
			}
		});

		it("refuses a certifier and a Super-Admin", async () => {
			await expect(exportFor(ids.certifierProfileA, {})).rejects.toThrow();
			await expect(exportFor(ids.superAdmin, {})).rejects.toThrow();
		});

		it("carries only the caller's own submitted rows, never a draft", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2030-02-01",
				submittedBinText: "STMT-MINE",
			});
			await seedSubmission({
				waterPurveyorId: wpA,
				status: "draft",
				testDate: "2030-02-01",
				submittedBinText: "STMT-DRAFT",
			});
			await seedSubmission({
				waterPurveyorId: wpB,
				testDate: "2030-02-01",
				submittedBinText: "STMT-THEIRS",
			});

			const rows = await exportFor(ids.adminA, {
				from: "2030-02-01",
				to: "2030-02-01",
			});

			expect(rows.map((row) => row.submittedBinText)).toEqual(["STMT-MINE"]);
		});

		it("matches the list row for row under the same filters", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2030-03-01",
				testResult: "fail",
			});
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2030-03-31",
				testResult: "fail",
			});
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2030-03-15",
				testResult: "pass",
			});
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2030-04-01",
				testResult: "fail",
			});
			const filters = {
				result: "fail",
				from: "2030-03-01",
				to: "2030-03-31",
			} as const;

			const exported = await exportFor(ids.adminA, filters);
			const listed = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({ ...filters, pageSize: 100 });

			expect(exported).toHaveLength(2);
			expect(exported.map((row) => row.testDate)).toEqual(
				listed.rows.map((row) => row.testDate),
			);
		});

		it("refuses a range that ends before it starts", async () => {
			await expect(
				exportFor(ids.adminA, { from: "2030-03-31", to: "2030-03-01" }),
			).rejects.toThrow();
		});

		it("names the customer who occupied the asset on the test date", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: historyAsset,
				testDate: "2030-03-10",
			});
			await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: historyAsset,
				testDate: "2030-08-10",
			});

			const rows = await exportFor(ids.adminA, {
				from: "2030-03-10",
				to: "2030-08-10",
			});
			const onAsset = rows.filter((row) => row.bin === "STMT-HISTORY");

			// Newest first: after the sale, then before it.
			expect(onAsset.map((row) => row.customerName)).toEqual([
				"New Owner",
				"Old Owner",
			]);
		});

		it("names the new occupant on the changeover day itself", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: historyAsset,
				testDate: "2030-06-15",
			});

			const [row] = await exportFor(ids.adminA, {
				from: "2030-06-15",
				to: "2030-06-15",
			});

			expect(row?.customerName).toBe("New Owner");
		});

		it("names nobody for a date the asset's history shows unoccupied", async () => {
			// Today's occupant never had this test; borrowing their name would
			// put it on a statement line they have nothing to do with.
			await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: historyAsset,
				testDate: "2029-12-01",
			});

			const [row] = await exportFor(ids.adminA, {
				from: "2029-12-01",
				to: "2029-12-01",
			});

			expect(row).toMatchObject({ bin: "STMT-HISTORY", customerName: null });
		});

		it("falls back to the current customer for an asset with no history", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: noHistoryAsset,
				testDate: "2030-05-05",
			});

			const [row] = await exportFor(ids.adminA, {
				from: "2030-05-05",
				to: "2030-05-05",
			});

			expect(row).toMatchObject({
				bin: "STMT-POINTER",
				customerName: "Pointer Only",
				serviceAddress: "6 Pointer Pl",
			});
		});

		it("keeps an unresolved submission, with its customer and address blank", async () => {
			await seedSubmission({
				waterPurveyorId: wpA,
				testDate: "2030-05-06",
				submittedBinText: "STMT-TYPED",
			});

			const [row] = await exportFor(ids.adminA, {
				from: "2030-05-06",
				to: "2030-05-06",
			});

			expect(row).toMatchObject({
				bin: null,
				submittedBinText: "STMT-TYPED",
				customerName: null,
				serviceAddress: null,
			});
		});

		it("never carries another purveyor's asset or customer through a crossed link", async () => {
			// Straight to SQL: no procedure will make this link.
			await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: foreignHistoryAsset,
				testDate: "2030-05-07",
				submittedBinText: "STMT-CROSSED",
			});

			const [row] = await exportFor(ids.adminA, {
				from: "2030-05-07",
				to: "2030-05-07",
			});

			expect(row).toMatchObject({
				bin: null,
				serviceAddress: null,
				customerName: null,
			});
		});

		it("logs one structured line with the range and the row count", async () => {
			await seedSubmission({ waterPurveyorId: wpA, testDate: "2030-05-08" });
			const lines = captureLogs();

			await exportFor(ids.employeeA, { from: "2030-05-08", to: "2030-05-08" });

			expect(
				lines.find((line) => line.event === "submitted_tests_exported"),
			).toMatchObject({
				actor_id: ids.employeeA,
				wp_id: wpA,
				from: "2030-05-08",
				to: "2030-05-08",
				result: null,
				row_count: 1,
			});
		});

		it("puts the same customer on the list row as on the statement line", async () => {
			const id = await seedSubmission({
				waterPurveyorId: wpA,
				bfaAssetId: historyAsset,
				testDate: "2030-03-11",
			});

			const { rows } = await callerFor(
				ids.adminA,
			).submittedTests.listSubmittedTests({
				from: "2030-03-11",
				to: "2030-03-11",
			});

			expect(rows.find((row) => row.id === id)?.customerName).toBe("Old Owner");
		});

		it("refuses past the row limit rather than returning a partial statement", async () => {
			const { rows } = await pool.query<{ id: string }>(
				`insert into test_submissions
				   (bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
				    wizard_data, test_date, test_result)
				 select null, $1, $2, 'submitted', 'RP', '{}'::jsonb, '2031-01-01', 'pass'
				 from generate_series(1, 5001)
				 returning id`,
				[certifierA, wpA],
			);
			created.push(...rows.map((row) => row.id));

			await expect(
				exportFor(ids.adminA, { from: "2031-01-01", to: "2031-01-01" }),
			).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
		});
	});
});
