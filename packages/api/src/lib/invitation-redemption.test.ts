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

import type { AuthAdmin } from "./auth-admin";
import { hashInvitationSecret } from "./invitation-token";

/**
 * Redemption against real Postgres, with a stand-in for the Supabase Auth
 * server. The database half is what these tests are about — the transaction, the
 * conditional claim on the invitation, the certifier rows, and the rollback that
 * must leave nothing behind. Creating throwaway accounts on a shared Auth
 * project to assert a rollback is not something a test suite should do, which is
 * why `AuthAdmin` is a port.
 *
 * Opt-in: this suite writes to a real database, so it runs only under
 * `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

type Redemption = typeof import("./invitation-redemption");

let redemption: Redemption;
let pool: pg.Pool;

const wpA = randomUUID();
const wpB = randomUUID();
const createdProfileIds = new Set<string>();

/** Records what the real Auth admin would have done, and can be told to fail. */
function fakeAuthAdmin(seed: Record<string, string> = {}) {
	const users = new Map(Object.entries(seed));
	const deleted: string[] = [];

	const admin: AuthAdmin = {
		findUserIdByEmail: async (email) => users.get(email.toLowerCase()) ?? null,
		createUser: async ({ email }) => {
			const id = randomUUID();
			users.set(email.toLowerCase(), id);
			createdProfileIds.add(id);
			return id;
		},
		deleteUser: async (userId) => {
			deleted.push(userId);
			for (const [email, id] of users) {
				if (id === userId) users.delete(email);
			}
		},
	};

	return { admin, deleted, users };
}

async function insertInvitation(overrides: {
	email: string;
	role: "wp_admin" | "wp_sub_admin" | "wp_employee" | "certifier";
	secret: string;
	associatedWpId?: string | null;
	proposedWaterPurveyorName?: string;
	expiresAt?: Date;
	status?: "pending" | "redeemed" | "expired";
	isRedeemed?: boolean;
	certifierType?: "internal" | "external";
}) {
	const id = randomUUID();
	const associatedWpId =
		overrides.associatedWpId === undefined ? wpA : overrides.associatedWpId;

	await pool.query(
		`insert into invitations (id, email, role, token, status, expires_at, associated_wp_id, proposed_water_purveyor_name, is_redeemed, certifier_type)
		 values ($1, $2, $3::invitation_role, $4, $5::invitation_status, $6, $7, $8, $9, $10::certifier_type)`,
		[
			id,
			overrides.email,
			overrides.role,
			hashInvitationSecret(overrides.secret),
			overrides.status ?? "pending",
			overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			associatedWpId,
			// The check constraint ties this to the shape of the row: a name
			// exactly when the invitation provisions a purveyor, never otherwise.
			associatedWpId === null
				? (overrides.proposedWaterPurveyorName ?? "Brand New Water District")
				: null,
			overrides.isRedeemed ?? false,
			overrides.certifierType ?? null,
		],
	);

	return id;
}

async function invitationRow(id: string) {
	const { rows } = await pool.query(
		"select status, is_redeemed from invitations where id = $1",
		[id],
	);

	return rows[0] as { status: string; is_redeemed: boolean } | undefined;
}

describeDb("redeemInvitation", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
		redemption = await import("./invitation-redemption");

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Redemption Fixture Water Works', 'REDEEM-A', 'active'),
			        ($2, 'Redemption Fixture Water Works', 'REDEEM-B', 'active')`,
			[wpA, wpB],
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		const ids = [...createdProfileIds];
		await pool.query(
			"delete from invitations where associated_wp_id = any($1::uuid[]) or associated_wp_id is null and email like 'redeem.%@example.com'",
			[[wpA, wpB]],
		);
		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id in (select id from certifiers where profile_id = any($1::uuid[]))",
			[ids],
		);
		await pool.query(
			"delete from certifiers where profile_id = any($1::uuid[])",
			[ids],
		);
		// A new-purveyor redemption creates its own water purveyor row, reachable
		// only through the profile it created.
		const { rows } = await pool.query(
			"select distinct water_purveyor_id from profiles where id = any($1::uuid[]) and water_purveyor_id is not null",
			[ids],
		);
		await pool.query("delete from profiles where id = any($1::uuid[])", [ids]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB, ...rows.map((row) => row.water_purveyor_id)],
		]);
		await pool.end();
	});

	describe("token validation", () => {
		it("rejects a token that matches nothing", async () => {
			const { admin } = fakeAuthAdmin();

			await expect(
				redemption.redeemInvitation(
					{ secret: "not-a-real-token" },
					{ authAdmin: admin },
				),
			).rejects.toMatchObject({ reason: "not_found" });
		});

		it("rejects an expired invitation", async () => {
			const secret = `expired-${randomUUID()}`;
			await insertInvitation({
				email: "redeem.expired@example.com",
				role: "wp_employee",
				secret,
				expiresAt: new Date(Date.now() - 60_000),
			});
			const { admin } = fakeAuthAdmin();

			await expect(
				redemption.redeemInvitation(
					{ secret, password: "correct horse battery", fullName: "Ex Pired" },
					{ authAdmin: admin },
				),
			).rejects.toMatchObject({ reason: "expired" });
		});

		it("rejects an invitation that was already redeemed", async () => {
			const secret = `used-${randomUUID()}`;
			await insertInvitation({
				email: "redeem.used@example.com",
				role: "wp_employee",
				secret,
				status: "redeemed",
				isRedeemed: true,
			});
			const { admin } = fakeAuthAdmin();

			await expect(
				redemption.redeemInvitation(
					{ secret, password: "correct horse battery", fullName: "Al Ready" },
					{ authAdmin: admin },
				),
			).rejects.toMatchObject({ reason: "redeemed" });
		});

		it("creates no account for a rejected token", async () => {
			const { admin, users } = fakeAuthAdmin();

			await expect(
				redemption.redeemInvitation({ secret: "nope" }, { authAdmin: admin }),
			).rejects.toThrow();

			expect(users.size).toBe(0);
		});
	});

	describe("successful redemption", () => {
		it("creates a WP profile and marks the invitation redeemed", async () => {
			const secret = `wp-${randomUUID()}`;
			const invitationId = await insertInvitation({
				email: "redeem.employee@example.com",
				role: "wp_employee",
				secret,
			});
			const { admin } = fakeAuthAdmin();

			const result = await redemption.redeemInvitation(
				{
					secret,
					password: "correct horse battery",
					fullName: "  Wanda Purveyor  ",
				},
				{ authAdmin: admin },
			);

			expect(result).toMatchObject({
				mode: "new_profile",
				globalRole: "wp_employee",
				waterPurveyorId: wpA,
				credentialsCreated: true,
			});
			expect(await invitationRow(invitationId)).toEqual({
				status: "redeemed",
				is_redeemed: true,
			});

			const { rows } = await pool.query(
				"select full_name, global_role, water_purveyor_id from profiles where id = $1",
				[result.profileId],
			);
			expect(rows[0]).toMatchObject({
				full_name: "Wanda Purveyor",
				global_role: "wp_employee",
				water_purveyor_id: wpA,
			});
		});

		it("creates the certifier and its authorization alongside the profile", async () => {
			const secret = `cert-${randomUUID()}`;
			await insertInvitation({
				email: "redeem.certifier@example.com",
				role: "certifier",
				secret,
			});
			const { admin } = fakeAuthAdmin();

			const result = await redemption.redeemInvitation(
				{
					secret,
					password: "correct horse battery",
					fullName: "Redemption Casey",
					certifier: {
						company: "Redemption Casey Testing",
						idNumber: "CERT-9001",
						licenseExpirationDate: "2029-01-31",
					},
				},
				{ authAdmin: admin },
			);

			// A certifier belongs to no single purveyor; reach comes from the
			// authorization rows, not from `profiles.water_purveyor_id`.
			expect(result.waterPurveyorId).toBeNull();

			const { rows } = await pool.query(
				`select c.company, c.id_number, c.license_expiration_date, a.water_purveyor_id, a.authorization_status, a.certifier_type
				 from certifiers c
				 join wp_certifier_authorizations a on a.certifier_id = c.id
				 where c.profile_id = $1`,
				[result.profileId],
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				company: "Redemption Casey Testing",
				id_number: "CERT-9001",
				water_purveyor_id: wpA,
				authorization_status: "active",
				// An invitation that names no type — one sent before the choice
				// existed — files the certifier as external.
				certifier_type: "external",
			});
		});

		it("files the certifier under the type the invitation names", async () => {
			const secret = `cert-${randomUUID()}`;
			await insertInvitation({
				email: "redeem.internal@example.com",
				role: "certifier",
				secret,
				certifierType: "internal",
			});
			const { admin } = fakeAuthAdmin();

			const result = await redemption.redeemInvitation(
				{
					secret,
					password: "correct horse battery",
					fullName: "Redemption Indy",
					certifier: {
						company: "Redemption Indy Testing",
						idNumber: "CERT-9002",
						licenseExpirationDate: "2029-01-31",
					},
				},
				{ authAdmin: admin },
			);

			const { rows } = await pool.query(
				`select a.certifier_type
				 from certifiers c
				 join wp_certifier_authorizations a on a.certifier_id = c.id
				 where c.profile_id = $1`,
				[result.profileId],
			);

			expect(rows).toEqual([{ certifier_type: "internal" }]);
		});

		it("creates the purveyor with the name from the invitation, never from the form", async () => {
			const secret = `newwp-${randomUUID()}`;
			const invitationId = await insertInvitation({
				email: "redeem.newwp@example.com",
				role: "wp_admin",
				secret,
				associatedWpId: null,
				proposedWaterPurveyorName: "Riverside Water District",
			});
			const { admin } = fakeAuthAdmin();

			// The screen shows the name the Super-Admin already chose instead of
			// asking for one, so the redemption input carries no company name.
			const inspection = await redemption.inspectInvitation(secret, {
				authAdmin: admin,
			});
			expect(inspection).toMatchObject({
				state: "valid",
				mode: "new_water_purveyor",
				invitation: { waterPurveyorName: "Riverside Water District" },
			});

			const result = await redemption.redeemInvitation(
				{
					secret,
					password: "correct horse battery",
					fullName: "First Admin",
				},
				{ authAdmin: admin },
			);

			expect(result.mode).toBe("new_water_purveyor");
			expect(result.waterPurveyorId).not.toBeNull();

			const { rows } = await pool.query(
				"select company_name from water_purveyors where id = $1",
				[result.waterPurveyorId],
			);
			expect(rows[0]).toMatchObject({
				company_name: "Riverside Water District",
			});
			expect(await invitationRow(invitationId)).toEqual({
				status: "redeemed",
				is_redeemed: true,
			});
		});

		it("logs the redemption as structured JSON", async () => {
			const lines: Record<string, unknown>[] = [];
			vi.spyOn(console, "log").mockImplementation((value: unknown) => {
				lines.push(JSON.parse(String(value)));
			});

			const secret = `log-${randomUUID()}`;
			const invitationId = await insertInvitation({
				email: "redeem.logged@example.com",
				role: "wp_admin",
				secret,
			});
			const { admin } = fakeAuthAdmin();

			const result = await redemption.redeemInvitation(
				{ secret, password: "correct horse battery", fullName: "Logged Admin" },
				{ authAdmin: admin },
			);

			expect(lines).toContainEqual(
				expect.objectContaining({
					event: "invitation_redeemed",
					actor_id: result.profileId,
					invitation_id: invitationId,
					role: "wp_admin",
					wp_id: wpA,
				}),
			);
		});
	});

	describe("existing certifier invited by a second purveyor", () => {
		it("files them under the type the second purveyor chose, leaving the first as it was", async () => {
			const email = "redeem.typed.twowp@example.com";
			const firstSecret = `first-${randomUUID()}`;
			await insertInvitation({ email, role: "certifier", secret: firstSecret });

			const { admin } = fakeAuthAdmin();
			const first = await redemption.redeemInvitation(
				{
					secret: firstSecret,
					password: "correct horse battery",
					fullName: "Redemption Riley",
					certifier: {
						company: "Redemption Riley Testing",
						idNumber: "CERT-7100",
						licenseExpirationDate: "2030-06-30",
					},
				},
				{ authAdmin: admin },
			);

			const secondSecret = `second-${randomUUID()}`;
			await insertInvitation({
				email,
				role: "certifier",
				secret: secondSecret,
				associatedWpId: wpB,
				certifierType: "internal",
			});
			await redemption.redeemInvitation(
				{ secret: secondSecret },
				{ authAdmin: admin },
			);

			const { rows } = await pool.query(
				`select a.water_purveyor_id, a.certifier_type
				 from wp_certifier_authorizations a
				 join certifiers c on c.id = a.certifier_id
				 where c.profile_id = $1`,
				[first.profileId],
			);
			const typeFor = (wp: string) =>
				rows.find((row) => row.water_purveyor_id === wp)?.certifier_type;

			expect(typeFor(wpB)).toBe("internal");
			expect(typeFor(wpA)).toBe("external");

			// Invited again by the same purveyor with the other type: the existing
			// authorization keeps its type — moving it is the Certifiers screen's
			// job, not a side effect of a repeat invitation.
			const repeatSecret = `repeat-${randomUUID()}`;
			await insertInvitation({
				email,
				role: "certifier",
				secret: repeatSecret,
				associatedWpId: wpB,
				certifierType: "external",
			});
			await redemption.redeemInvitation(
				{ secret: repeatSecret },
				{ authAdmin: admin },
			);

			const { rows: after } = await pool.query(
				`select a.certifier_type
				 from wp_certifier_authorizations a
				 join certifiers c on c.id = a.certifier_id
				 where c.profile_id = $1 and a.water_purveyor_id = $2`,
				[first.profileId, wpB],
			);
			expect(after).toEqual([{ certifier_type: "internal" }]);
		});

		it("adds only the authorization and leaves the profile untouched", async () => {
			const email = "redeem.twowp@example.com";
			const firstSecret = `first-${randomUUID()}`;
			await insertInvitation({ email, role: "certifier", secret: firstSecret });

			const { admin, users } = fakeAuthAdmin();
			const first = await redemption.redeemInvitation(
				{
					secret: firstSecret,
					password: "correct horse battery",
					fullName: "Redemption Morgan",
					certifier: {
						company: "Redemption Morgan Testing",
						idNumber: "CERT-7000",
						licenseExpirationDate: "2030-06-30",
					},
				},
				{ authAdmin: admin },
			);

			const secondSecret = `second-${randomUUID()}`;
			const secondInvitation = await insertInvitation({
				email,
				role: "certifier",
				secret: secondSecret,
				associatedWpId: wpB,
			});

			const inspection = await redemption.inspectInvitation(secondSecret, {
				authAdmin: admin,
			});
			expect(inspection).toMatchObject({
				state: "valid",
				mode: "existing_certifier",
			});

			// No password, no name, no certifier details — the form is skipped.
			const second = await redemption.redeemInvitation(
				{ secret: secondSecret },
				{ authAdmin: admin },
			);

			expect(second).toMatchObject({
				mode: "existing_certifier",
				profileId: first.profileId,
				credentialsCreated: false,
			});
			// No second account was created for the same address.
			expect(users.size).toBe(1);

			const { rows: certifierRows } = await pool.query(
				"select id, company, id_number from certifiers where profile_id = $1",
				[first.profileId],
			);
			expect(certifierRows).toHaveLength(1);
			expect(certifierRows[0]).toMatchObject({
				company: "Redemption Morgan Testing",
				id_number: "CERT-7000",
			});

			const { rows: profileRows } = await pool.query(
				"select full_name, global_role from profiles where id = $1",
				[first.profileId],
			);
			expect(profileRows[0]).toMatchObject({
				full_name: "Redemption Morgan",
				global_role: "certifier",
			});

			const { rows: authRows } = await pool.query(
				"select water_purveyor_id from wp_certifier_authorizations where certifier_id = $1 order by water_purveyor_id",
				[certifierRows[0].id],
			);
			expect(authRows.map((row) => row.water_purveyor_id).sort()).toEqual(
				[wpA, wpB].sort(),
			);
			expect(await invitationRow(secondInvitation)).toEqual({
				status: "redeemed",
				is_redeemed: true,
			});
		});

		it("reports an address that already belongs to a non-certifier as in use", async () => {
			const email = "redeem.collision@example.com";
			const firstSecret = `collide-first-${randomUUID()}`;
			await insertInvitation({
				email,
				role: "wp_employee",
				secret: firstSecret,
			});

			const { admin } = fakeAuthAdmin();
			await redemption.redeemInvitation(
				{
					secret: firstSecret,
					password: "correct horse battery",
					fullName: "Already Here",
				},
				{ authAdmin: admin },
			);

			const secondSecret = `collide-second-${randomUUID()}`;
			await insertInvitation({
				email,
				role: "certifier",
				secret: secondSecret,
				associatedWpId: wpB,
			});

			await expect(
				redemption.redeemInvitation(
					{ secret: secondSecret },
					{ authAdmin: admin },
				),
			).rejects.toMatchObject({ reason: "email_in_use" });
		});
	});

	describe("atomicity", () => {
		it("leaves no profile, no invitation change and no account behind when the transaction fails", async () => {
			const secret = `rollback-${randomUUID()}`;
			const invitationId = await insertInvitation({
				email: "redeem.rollback@example.com",
				role: "certifier",
				secret,
			});
			const { admin, deleted } = fakeAuthAdmin();

			// A certifier invitation with no certifier details fails after the
			// invitation has been claimed and the profile inserted.
			await expect(
				redemption.redeemInvitation(
					{
						secret,
						password: "correct horse battery",
						fullName: "Rolled Back",
					},
					{ authAdmin: admin },
				),
			).rejects.toMatchObject({ reason: "invalid_input" });

			expect(await invitationRow(invitationId)).toEqual({
				status: "pending",
				is_redeemed: false,
			});

			const { rows } = await pool.query(
				"select id from profiles where full_name = 'Rolled Back'",
			);
			expect(rows).toHaveLength(0);

			// The auth user is the one write outside the transaction, so it is
			// undone by hand — otherwise the address could never be re-invited.
			expect(deleted).toHaveLength(1);
			expect(
				await admin.findUserIdByEmail("redeem.rollback@example.com"),
			).toBeNull();
		});

		it("lets only one of two concurrent redemptions through", async () => {
			const secret = `race-${randomUUID()}`;
			const invitationId = await insertInvitation({
				email: "redeem.race@example.com",
				role: "wp_employee",
				secret,
			});
			const { admin } = fakeAuthAdmin();

			const attempts = await Promise.allSettled([
				redemption.redeemInvitation(
					{ secret, password: "correct horse battery", fullName: "Racer One" },
					{ authAdmin: admin },
				),
				redemption.redeemInvitation(
					{ secret, password: "correct horse battery", fullName: "Racer Two" },
					{ authAdmin: admin },
				),
			]);

			expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
			expect(await invitationRow(invitationId)).toEqual({
				status: "redeemed",
				is_redeemed: true,
			});

			const { rows } = await pool.query(
				"select id from profiles where full_name in ('Racer One', 'Racer Two')",
			);
			expect(rows).toHaveLength(1);
		});
	});
});
