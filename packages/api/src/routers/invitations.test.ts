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

import { hashInvitationSecret } from "../lib/invitation-token";

/**
 * `createInvitation` end to end against real Postgres: Zod validation, the
 * server-side tenant decision, the stored digest, and the console driver's
 * invite link, in the order a real call hits them.
 *
 * Opt-in: this suite writes to a real database, so it runs only under
 * `npm run test:db`.
 */

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

const wpA = randomUUID();
const wpB = randomUUID();
const adminA = randomUUID();
const employeeA = randomUUID();
const certifier = randomUUID();
const superAdmin = randomUUID();

let pool: pg.Pool;
let callerFor: (profileId: string) => {
	invitations: {
		createInvitation: (input: {
			email: string;
			role: "wp_admin" | "wp_sub_admin" | "wp_employee" | "certifier";
			waterPurveyorId?: string | null;
			proposedWaterPurveyorName?: string;
			expiresInDays?: number;
		}) => Promise<{
			id: string;
			email: string;
			waterPurveyorId: string | null;
			proposedWaterPurveyorName: string | null;
		}>;
	};
};

function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

describeDb("createInvitation", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const { t } = await import("../index");
		const { appRouter } = await import("./index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				// `protectedProcedure` re-resolves the profile from the database, so
				// only the auth user id matters here — the Supabase client is never
				// touched once a user is present.
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			});

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Invite Fixture Water Works', 'INVITE-A', 'active'),
			        ($2, 'Invite Fixture Water Works', 'INVITE-B', 'active')`,
			[wpA, wpB],
		);

		const profiles: [string, string | null, string][] = [
			[adminA, wpA, "wp_admin"],
			[employeeA, wpA, "wp_employee"],
			[certifier, null, "certifier"],
			[superAdmin, null, "super_admin"],
		];

		for (const [id, wp, role] of profiles) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, $2, 'Invite Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from invitations where invited_by_profile_id = any($1::uuid[])",
			[[adminA, employeeA, certifier, superAdmin]],
		);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			[adminA, employeeA, certifier, superAdmin],
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wpA, wpB],
		]);
		await pool.end();
	});

	it("stores a digest, not the secret, and prints a matching link", async () => {
		const lines = captureLogs();

		const invitation = await callerFor(adminA).invitations.createInvitation({
			email: "Invitee.One@Example.com ",
			role: "certifier",
		});

		expect(invitation.email).toBe("invitee.one@example.com");
		expect(invitation.waterPurveyorId).toBe(wpA);

		const delivery = lines.find(
			(line) => line.event === "email_console_delivery",
		);
		const link = String(delivery?.html).match(
			/\/invite\/([A-Za-z0-9_-]+)/,
		)?.[1];

		expect(link).toBeDefined();

		const { rows } = await pool.query(
			"select token, role, associated_wp_id, is_redeemed, status from invitations where id = $1",
			[invitation.id],
		);

		expect(rows[0]).toMatchObject({
			token: hashInvitationSecret(link as string),
			role: "certifier",
			associated_wp_id: wpA,
			is_redeemed: false,
			status: "pending",
		});
		// The secret must not be recoverable from the row.
		expect(rows[0].token).not.toBe(link);
	});

	it("logs the creation as structured JSON", async () => {
		const lines = captureLogs();

		const invitation = await callerFor(employeeA).invitations.createInvitation({
			email: "invitee.two@example.com",
			role: "certifier",
		});

		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "invitation_created",
				actor_id: employeeA,
				invitation_id: invitation.id,
				recipient: "invitee.two@example.com",
				role: "certifier",
				wp_id: wpA,
			}),
		);
	});

	it("refuses a purveyor id that is not the caller's own", async () => {
		captureLogs();

		await expect(
			callerFor(adminA).invitations.createInvitation({
				email: "cross.tenant@example.com",
				role: "wp_employee",
				waterPurveyorId: wpB,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses a certifier sending invitations", async () => {
		captureLogs();

		await expect(
			callerFor(certifier).invitations.createInvitation({
				email: "nope@example.com",
				role: "certifier",
				waterPurveyorId: wpA,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects a malformed email before anything is written", async () => {
		captureLogs();

		await expect(
			callerFor(adminA).invitations.createInvitation({
				email: "not-an-email",
				role: "certifier",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("lets a Super-Admin create a new-purveyor invitation, storing its name", async () => {
		captureLogs();

		const invitation = await callerFor(superAdmin).invitations.createInvitation(
			{
				email: "new.purveyor@example.com",
				role: "wp_admin",
				waterPurveyorId: null,
				proposedWaterPurveyorName: "  Riverside Water District  ",
			},
		);

		expect(invitation.waterPurveyorId).toBeNull();
		expect(invitation.proposedWaterPurveyorName).toBe(
			"Riverside Water District",
		);

		const { rows } = await pool.query(
			"select role, associated_wp_id, proposed_water_purveyor_name from invitations where id = $1",
			[invitation.id],
		);
		expect(rows[0]).toMatchObject({
			role: "wp_admin",
			associated_wp_id: null,
			proposed_water_purveyor_name: "Riverside Water District",
		});
	});

	it("names the purveyor being created in the invite email", async () => {
		const lines = captureLogs();

		await callerFor(superAdmin).invitations.createInvitation({
			email: "named.purveyor@example.com",
			role: "wp_admin",
			waterPurveyorId: null,
			proposedWaterPurveyorName: "Lakeside Water District",
		});

		const delivery = lines.find(
			(line) => line.event === "email_console_delivery",
		);
		expect(String(delivery?.html)).toContain("Lakeside Water District");
	});

	it("requires a name on a new-purveyor invitation", async () => {
		captureLogs();

		await expect(
			callerFor(superAdmin).invitations.createInvitation({
				email: "unnamed.purveyor@example.com",
				role: "wp_admin",
				waterPurveyorId: null,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses a name on an invitation into an existing purveyor", async () => {
		captureLogs();

		await expect(
			callerFor(superAdmin).invitations.createInvitation({
				email: "named.joiner@example.com",
				role: "wp_employee",
				waterPurveyorId: wpB,
				proposedWaterPurveyorName: "Riverside Water District",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses a WP Admin creating a new-purveyor invitation", async () => {
		captureLogs();

		await expect(
			callerFor(adminA).invitations.createInvitation({
				email: "sneaky.purveyor@example.com",
				role: "wp_admin",
				waterPurveyorId: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses any WP role that names a purveyor to create", async () => {
		captureLogs();

		for (const writer of [adminA, employeeA]) {
			await expect(
				callerFor(writer).invitations.createInvitation({
					email: "sneaky.purveyor@example.com",
					role: "wp_admin",
					proposedWaterPurveyorName: "Sneaky Water District",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}

		// And nothing reached the table on the way to being refused.
		const { rows } = await pool.query(
			"select id from invitations where email = $1",
			["sneaky.purveyor@example.com"],
		);
		expect(rows).toHaveLength(0);
	});

	it("refuses a certifier naming a purveyor to create", async () => {
		captureLogs();

		await expect(
			callerFor(certifier).invitations.createInvitation({
				email: "certifier.purveyor@example.com",
				role: "wp_admin",
				proposedWaterPurveyorName: "Sneaky Water District",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
