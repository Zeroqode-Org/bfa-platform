import { randomUUID } from "node:crypto";

import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `noBinSubmission` against real Postgres, through the three places that use
 * it: the dashboard's No-BIN card, the dashboard's No-BIN list, and the
 * Submitted Tests screen's `bin: "none"` filter.
 *
 * The predicate is a correlated `not exists` over an aliased `bfa_assets`, and
 * the three callers wrap it in differently shaped outer queries — the card and
 * the list's `total` select from `test_submissions` alone, the list's rows and
 * the dashboard list left-join `bfa_assets` as well. Drizzle drops table
 * qualifiers in a single-table select, so a correlation that renders correctly
 * in one shape can silently bind to the wrong table in another and match no
 * row or every row, with no error. Only a real database can show that; the
 * offline suites never render this SQL against a schema.
 *
 * The fixture has one row of each kind the predicate distinguishes — linked to
 * an asset with a BIN, linked to a no-BIN asset, not linked at all, and a
 * draft — and a second purveyor holding a no-BIN test of its own, so a leak
 * across tenants looks like a wrong count rather than a coincidence.
 *
 * Opt-in: writes real rows; runs only under `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wpA = randomUUID();
const wpB = randomUUID();

const ids = {
	adminA: randomUUID(),
	certProfile: randomUUID(),
};

const certifierId = randomUUID();

const assetIds = {
	withBin: randomUUID(),
	noBin: randomUUID(),
	foreignNoBin: randomUUID(),
};

const submissionIds = {
	/** Submitted, linked to an asset that has a BIN. Never no-BIN. */
	withBin: randomUUID(),
	/** Submitted, linked to the asset the wizard registered with no BIN. */
	noBinAsset: randomUUID(),
	/** Submitted before the wizard registered no-BIN assets: not linked. */
	unlinked: randomUUID(),
	/** A draft with no asset. Invisible to the WP, so counted nowhere. */
	draft: randomUUID(),
	/** wpB's no-BIN test. Must never reach wpA's card or lists. */
	foreign: randomUUID(),
};

let pool: pg.Pool;

type Probe = {
	dashboard: {
		dashboardMetrics: () => Promise<{ noBinSubmissions: number }>;
		noBinReports: (input: { limit: number }) => Promise<{ id: string }[]>;
	};
	submittedTests: {
		listSubmittedTests: (input: {
			page: number;
			pageSize: number;
			bin?: "none";
		}) => Promise<{ rows: { id: string }[]; total: number }>;
	};
};

let callerFor: (profileId: string) => Probe;

describeDb("No-BIN submissions (database)", () => {
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
			}) as unknown as Probe;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'No-BIN Fixture A', 'NOBIN-A', 'active'),
			        ($2, 'No-BIN Fixture B', 'NOBIN-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string, string][] = [
			[ids.adminA, wpA, "Nalu Admin", "wp_admin"],
			[ids.certProfile, null, "Keoni Certifier", "certifier"],
		];

		for (const [id, wp, name, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, $3, $4::global_role, 'active')`,
				[id, wp, name, role],
			);
		}

		await pool.query(
			`insert into certifiers (id, profile_id, company, id_number, status)
			 values ($1, $2, 'No-BIN Backflow', 'HI-NB', 'active')`,
			[certifierId, ids.certProfile],
		);
		await pool.query(
			`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
			 values ($1, $2, 'active'), ($1, $3, 'active')`,
			[certifierId, wpA, wpB],
		);

		const assets: [string, string, string | null][] = [
			[assetIds.withBin, wpA, `NOBIN-${randomUUID().slice(0, 8)}`],
			[assetIds.noBin, wpA, null],
			[assetIds.foreignNoBin, wpB, null],
		];

		for (const [id, wp, bin] of assets) {
			await pool.query(
				`insert into bfa_assets (id, water_purveyor_id, bin, bfa_type, service_address)
				 values ($1, $2, $3, 'RP', '7 Puna Road')`,
				[id, wp, bin],
			);
		}

		const submissions: [
			string,
			string | null,
			string,
			"draft" | "submitted",
			"pass" | null,
		][] = [
			[submissionIds.withBin, assetIds.withBin, wpA, "submitted", "pass"],
			[submissionIds.noBinAsset, assetIds.noBin, wpA, "submitted", "pass"],
			[submissionIds.unlinked, null, wpA, "submitted", "pass"],
			[submissionIds.draft, null, wpA, "draft", null],
			[submissionIds.foreign, assetIds.foreignNoBin, wpB, "submitted", "pass"],
		];

		for (const [id, assetId, wp, status, result] of submissions) {
			await pool.query(
				`insert into test_submissions
				   (id, bfa_asset_id, certifier_id, water_purveyor_id, status, bfa_type,
				    wizard_data, test_date, test_result, signature_method)
				 values ($1, $2, $3, $4, $5::submission_status, 'RP', '{}'::jsonb,
				         '2026-09-01', $6::test_result, 'signed')`,
				[id, assetId, certifierId, wp, status, result],
			);
		}
	});

	afterAll(async () => {
		if (!pool) return;

		const wps = [[wpA, wpB]];

		await pool.query(
			"delete from test_submissions where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from bfa_assets where water_purveyor_id = any($1::uuid[])",
			wps,
		);
		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id = $1",
			[certifierId],
		);
		await pool.query("delete from certifiers where id = $1", [certifierId]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query(
			"delete from water_purveyors where id = any($1::uuid[])",
			wps,
		);
		await pool.end();
	});

	/** The two rows every caller of the predicate must agree on. */
	const expectedNoBin = [submissionIds.noBinAsset, submissionIds.unlinked];

	it("the dashboard card counts the no-BIN-asset test and the unlinked one", async () => {
		const metrics = await callerFor(ids.adminA).dashboard.dashboardMetrics();

		// Single-table select over test_submissions: the shape where a dropped
		// qualifier would make this 0 (nothing matches) or 3 (everything does).
		expect(metrics.noBinSubmissions).toBe(2);
	});

	it("the dashboard No-BIN list returns exactly those two", async () => {
		const rows = await callerFor(ids.adminA).dashboard.noBinReports({
			limit: 20,
		});

		expect(rows.map((row) => row.id).sort()).toEqual([...expectedNoBin].sort());
	});

	it("the Submitted Tests bin filter totals and lists the same two", async () => {
		const page = await callerFor(ids.adminA).submittedTests.listSubmittedTests({
			page: 1,
			pageSize: 25,
			bin: "none",
		});

		// `total` is the single-table count; `rows` join bfa_assets. Both are
		// asserted because they are the two outer shapes the predicate lives in.
		expect(page.total).toBe(2);
		expect(page.rows.map((row) => row.id).sort()).toEqual(
			[...expectedNoBin].sort(),
		);
	});

	it("without the bin filter, every submitted test is listed and the draft is not", async () => {
		const page = await callerFor(ids.adminA).submittedTests.listSubmittedTests({
			page: 1,
			pageSize: 25,
		});

		expect(page.total).toBe(3);
		expect(page.rows.map((row) => row.id).sort()).toEqual(
			[
				submissionIds.withBin,
				submissionIds.noBinAsset,
				submissionIds.unlinked,
			].sort(),
		);
	});
});
