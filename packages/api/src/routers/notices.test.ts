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

import { EMAIL_BRAND_NAME } from "../lib/email-layout";
import { PLATFORM_DEFAULT_NOTICE_TEMPLATES } from "../lib/notice-defaults";

/**
 * The notices procedures against real Postgres: who may read the templates, who
 * may rewrite them, who may send a broadcast, and — the part that matters — who
 * a broadcast actually reaches.
 *
 * Two purveyors are seeded with deliberately interchangeable customers and
 * templates. A leak between them has to look like a leak, not like a plausible
 * row.
 *
 * These run through the privileged Drizzle connection, exactly as a real
 * request does, so what passes here is the application's own tenant boundary.
 * The row policies are a second, independent boundary and have their own suite
 * in `packages/db/src/notice-templates-rls.test.ts`.
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
const customerIds = {
	standardA: randomUUID(),
	agriculturalA: randomUUID(),
	pastDueA: randomUUID(),
	suspendedA: randomUUID(),
	standardB: randomUUID(),
};
const assetIds = {
	pastDueOne: randomUUID(),
	pastDueTwo: randomUUID(),
	activeA: randomUUID(),
	pastDueB: randomUUID(),
};

let pool: pg.Pool;

type NoticeTemplateRow = {
	noticeType: "reminder" | "late_notice_1" | "late_notice_2" | "final_notice";
	label: string;
	subject: string;
	body: string;
	isCustomized: boolean;
	defaultSubject: string;
	defaultBody: string;
	updatedAt: Date | null;
};
type RecipientFilter = "all_customers" | "agricultural_only" | "past_due_only";

type NoticesCaller = {
	notices: {
		listNoticeTemplates: () => Promise<NoticeTemplateRow[]>;
		getNoticePreviewSample: () => Promise<{
			values: Record<string, string>;
		}>;
		upsertNoticeTemplate: (input: {
			noticeType: string;
			subject: string;
			body: string;
		}) => Promise<{
			id: string;
			subject: string | null;
			body: string | null;
			updatedAt: Date;
		}>;
		getBroadcastAudience: (input: {
			recipientFilter: RecipientFilter;
		}) => Promise<{
			recipientFilter: RecipientFilter;
			recipientCount: number;
		}>;
		sendGeneralInfoBroadcast: (input: {
			subject: string;
			body: string;
			recipientFilter: RecipientFilter;
		}) => Promise<{ recipientCount: number; sentCount: number }>;
	};
};

let callerFor: (profileId: string) => NoticesCaller;

/** Every JSON log line emitted while the test runs. */
function captureLogs() {
	const lines: Record<string, unknown>[] = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		lines.push(JSON.parse(String(value)));
	});

	return lines;
}

/** The `to` address of every message the console driver reported sending. */
function deliveredTo(lines: Record<string, unknown>[]) {
	return lines
		.filter((line) => line.event === "email_console_delivery")
		.map((line) => line.to as string);
}

describeDb("notices procedures", () => {
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
			}) as unknown as NoticesCaller;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Notices Fixture Water Works', 'NOTICE-A', 'active'),
			        ($2, 'Notices Fixture Water Works', 'NOTICE-B', 'active')`,
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
				 values ($1, $2, 'Notices Fixture', $3::global_role, 'active')`,
				[id, wp, role],
			);
		}

		// Same names and addresses in both tenants: a recipient from the wrong
		// purveyor is unmistakably wrong rather than plausible.
		await pool.query(
			`insert into customers (id, water_purveyor_id, name, email, rate_category, status)
			 values ($1, $2, 'Shared Name Farms', 'standard.a@example.com', 'standard', 'active'),
			        ($3, $2, 'Shared Ag Farms', 'ag.a@example.com', 'agricultural', 'active'),
			        ($4, $2, 'Shared Overdue Co', 'pastdue.a@example.com', 'standard', 'active'),
			        ($5, $2, 'Shared Suspended Co', 'suspended.a@example.com', 'agricultural', 'suspended'),
			        ($6, $7, 'Shared Name Farms', 'standard.b@example.com', 'standard', 'active')`,
			[
				customerIds.standardA,
				wpA,
				customerIds.agriculturalA,
				customerIds.pastDueA,
				customerIds.suspendedA,
				customerIds.standardB,
				wpB,
			],
		);

		// Two past-due assemblies for one customer: the de-duplication case.
		await pool.query(
			`insert into bfa_assets (id, water_purveyor_id, bin, current_customer_id, bfa_type, service_address, asset_status)
			 values ($1, $2, 'NOTICE-A-1', $3, 'RP', '1 Overdue Lane', 'past_due'),
			        ($4, $2, 'NOTICE-A-2', $3, 'DC', '2 Overdue Lane', 'past_due'),
			        ($5, $2, 'NOTICE-A-3', $6, 'RP', '3 Current Lane', 'active'),
			        ($7, $8, 'NOTICE-B-1', $9, 'RP', '1 Other Tenant Lane', 'past_due')`,
			[
				assetIds.pastDueOne,
				wpA,
				customerIds.pastDueA,
				assetIds.pastDueTwo,
				assetIds.activeA,
				customerIds.standardA,
				assetIds.pastDueB,
				wpB,
				customerIds.standardB,
			],
		);
	});

	beforeEach(async () => {
		// Each test starts from "nothing customized", so a fallback assertion in
		// one test cannot be answered by a row another test saved.
		await pool.query(
			"delete from notice_templates where water_purveyor_id = any($1::uuid[])",
			[[wpA, wpB]],
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from notice_templates where water_purveyor_id = any($1::uuid[])",
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
		it("refuses a certifier the read", async () => {
			await expect(
				callerFor(ids.certifier).notices.listNoticeTemplates(),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a Super-Admin, rather than showing every tenant's templates", async () => {
			// Cross-tenant access is a separate, deliberately designed endpoint if it
			// is ever wanted. It is not this WP-scoped router quietly answering for
			// whichever purveyor happens to be first.
			await expect(
				callerFor(ids.superAdmin).notices.listNoticeTemplates(),
			).rejects.toThrow(/water purveyor only/i);

			await expect(
				callerFor(ids.superAdmin).notices.upsertNoticeTemplate({
					noticeType: "reminder",
					subject: "Super Admin Wrote This",
					body: "Hello {{customer_name}}.",
				}),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("refuses a WP role whose profile carries no purveyor", async () => {
			await expect(
				callerFor(ids.orphanedWpAdmin).notices.listNoticeTemplates(),
			).rejects.toThrow(/no water purveyor/i);
		});

		it("lets every WP role in the tenant read the templates", async () => {
			for (const reader of [ids.adminA, ids.subAdminA, ids.employeeA]) {
				const rows = await callerFor(reader).notices.listNoticeTemplates();

				expect(rows).toHaveLength(4);
			}
		});

		it("refuses a SubAdmin and an Employee the write", async () => {
			for (const reader of [ids.subAdminA, ids.employeeA]) {
				await expect(
					callerFor(reader).notices.upsertNoticeTemplate({
						noticeType: "reminder",
						subject: "Read Only Tried To Write",
						body: "Hello {{customer_name}}.",
					}),
				).rejects.toThrow(/only a wp admin/i);
			}
		});

		it("refuses a SubAdmin and an Employee the broadcast", async () => {
			for (const reader of [ids.subAdminA, ids.employeeA]) {
				await expect(
					callerFor(reader).notices.sendGeneralInfoBroadcast({
						subject: "Read Only Tried To Send",
						body: "Hello {{customer_name}}.",
						recipientFilter: "all_customers",
					}),
				).rejects.toThrow(/only a wp admin/i);
			}
		});

		it("refuses a certifier the broadcast before the role check even applies", async () => {
			await expect(
				callerFor(ids.certifier).notices.sendGeneralInfoBroadcast({
					subject: "Certifier Tried To Send",
					body: "Hello {{customer_name}}.",
					recipientFilter: "all_customers",
				}),
			).rejects.toThrow(/water purveyor only/i);
		});

		it("lets a SubAdmin and an Employee read the broadcast audience", async () => {
			// Reading how many people a filter selects is not sending to them.
			for (const reader of [ids.subAdminA, ids.employeeA]) {
				const audience = await callerFor(reader).notices.getBroadcastAudience({
					recipientFilter: "all_customers",
				});

				expect(audience.recipientCount).toBeGreaterThan(0);
			}
		});
	});

	describe("listNoticeTemplates", () => {
		it("returns all four types, in escalation order, with nothing saved", async () => {
			const rows = await callerFor(ids.adminA).notices.listNoticeTemplates();

			expect(rows.map((row) => row.noticeType)).toEqual([
				"reminder",
				"late_notice_1",
				"late_notice_2",
				"final_notice",
			]);
		});

		it("falls back to the platform default rather than an empty template", async () => {
			const rows = await callerFor(ids.adminA).notices.listNoticeTemplates();
			const reminder = rows.find((row) => row.noticeType === "reminder");

			// The whole point of the fallback: an untouched type does not send blank.
			expect(reminder?.subject).toBe(
				PLATFORM_DEFAULT_NOTICE_TEMPLATES.reminder.subject,
			);
			expect(reminder?.body).toBe(
				PLATFORM_DEFAULT_NOTICE_TEMPLATES.reminder.body,
			);
			expect(reminder?.isCustomized).toBe(false);
			expect(reminder?.subject.trim()).not.toBe("");
		});

		it("marks a saved template as customized and returns its text", async () => {
			await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "late_notice_1",
				subject: "Our own late notice",
				body: "Hello {{customer_name}}, BIN {{bin}} is overdue.",
			});

			const rows = await callerFor(ids.adminA).notices.listNoticeTemplates();
			const late = rows.find((row) => row.noticeType === "late_notice_1");
			const untouched = rows.find((row) => row.noticeType === "final_notice");

			expect(late).toMatchObject({
				subject: "Our own late notice",
				isCustomized: true,
			});
			// Still exactly four, and the other three still fall back.
			expect(rows).toHaveLength(4);
			expect(untouched?.isCustomized).toBe(false);
		});

		it("treats a row with blank text as uncustomized rather than sending nothing", async () => {
			// The columns are nullable and the seed file writes only two of the four
			// types, so a half-written row is a state the table can hold.
			await pool.query(
				`insert into notice_templates (water_purveyor_id, notice_type, subject, body)
				 values ($1, 'final_notice', null, '   ')`,
				[wpA],
			);

			const rows = await callerFor(ids.adminA).notices.listNoticeTemplates();
			const final = rows.find((row) => row.noticeType === "final_notice");

			expect(final?.subject).toBe(
				PLATFORM_DEFAULT_NOTICE_TEMPLATES.final_notice.subject,
			);
			expect(final?.isCustomized).toBe(false);
		});

		it("shows a caller only their own purveyor's text", async () => {
			await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Tenant A reminder",
				body: "Hello {{customer_name}} from A.",
			});
			await callerFor(ids.adminB).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Tenant B reminder",
				body: "Hello {{customer_name}} from B.",
			});

			const fromA = await callerFor(ids.adminA).notices.listNoticeTemplates();
			const fromB = await callerFor(ids.adminB).notices.listNoticeTemplates();

			expect(fromA.find((row) => row.noticeType === "reminder")?.subject).toBe(
				"Tenant A reminder",
			);
			expect(fromB.find((row) => row.noticeType === "reminder")?.subject).toBe(
				"Tenant B reminder",
			);
		});
	});

	describe("getNoticePreviewSample", () => {
		it("uses the caller's real purveyor name and stand-ins for the rest", async () => {
			const { values } = await callerFor(
				ids.employeeA,
			).notices.getNoticePreviewSample();

			expect(values.wp_name).toBe("Notices Fixture Water Works");
			expect(values.customer_name).toBeTruthy();
			expect(values.bin).toBeTruthy();
			expect(values.due_date).toBeTruthy();
		});
	});

	describe("upsertNoticeTemplate", () => {
		it("creates the row on the first save and updates it on the second", async () => {
			const created = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "First save",
				body: "Hello {{customer_name}}.",
			});

			const updated = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Second save",
				body: "Hello again {{customer_name}}.",
			});

			// Same row, not a second one: the unique key is what makes this an
			// upsert rather than a race two saves could lose.
			expect(updated.id).toBe(created.id);
			expect(updated.subject).toBe("Second save");

			const { rows } = await pool.query(
				"select count(*)::int as count from notice_templates where water_purveyor_id = $1 and notice_type = 'reminder'",
				[wpA],
			);
			expect(rows[0]?.count).toBe(1);
		});

		it("files the template under the caller's own purveyor", async () => {
			const created = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "late_notice_2",
				subject: "Filed here",
				body: "Hello {{customer_name}}.",
			});

			const { rows } = await pool.query(
				"select water_purveyor_id from notice_templates where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("ignores a water purveyor sent by the client", async () => {
			const created = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Tried to pick a tenant",
				body: "Hello {{customer_name}}.",
				// Not part of the input shape — the cast is the point: even a client
				// that sends it gets its own tenant.
				waterPurveyorId: wpB,
			} as never);

			const { rows } = await pool.query(
				"select water_purveyor_id from notice_templates where id = $1",
				[created.id],
			);

			expect(rows[0]?.water_purveyor_id).toBe(wpA);
		});

		it("leaves the other tenant's template of the same type untouched", async () => {
			const theirs = await callerFor(ids.adminB).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Belongs to B",
				body: "Hello {{customer_name}} from B.",
			});

			await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Belongs to A",
				body: "Hello {{customer_name}} from A.",
			});

			const { rows } = await pool.query(
				"select subject from notice_templates where id = $1",
				[theirs.id],
			);

			// Same notice type, two tenants, two rows — the conflict target includes
			// the purveyor, so A's save cannot land on B's row.
			expect(rows[0]?.subject).toBe("Belongs to B");
		});

		it("never writes is_enabled", async () => {
			await pool.query(
				`insert into notice_templates (water_purveyor_id, notice_type, subject, body, is_enabled)
				 values ($1, 'reminder', 'Existing', 'Existing body', false)`,
				[wpA],
			);

			await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Rewritten",
				body: "Hello {{customer_name}}.",
				// The field is not in the schema; Zod strips it.
				isEnabled: true,
			} as never);

			const { rows } = await pool.query(
				"select is_enabled, subject from notice_templates where water_purveyor_id = $1 and notice_type = 'reminder'",
				[wpA],
			);

			expect(rows[0]).toMatchObject({
				is_enabled: false,
				subject: "Rewritten",
			});
		});

		it("writes nothing when the save changed nothing", async () => {
			const created = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "reminder",
				subject: "Saved Without Editing",
				body: "Hello {{customer_name}}.",
			});

			const { rows: before } = await pool.query(
				"select updated_at from notice_templates where id = $1",
				[created.id],
			);

			const lines = captureLogs();

			// Opening the template and pressing save. Both fields are sent on every
			// save, so the request looks exactly like a real edit.
			const returned = await callerFor(ids.adminA).notices.upsertNoticeTemplate(
				{
					noticeType: "reminder",
					subject: "Saved Without Editing",
					body: "Hello {{customer_name}}.",
				},
			);

			const { rows: after } = await pool.query(
				"select updated_at from notice_templates where id = $1",
				[created.id],
			);

			// The row comes back, so the client has nothing to handle differently.
			expect(returned.id).toBe(created.id);
			// But `updated_at` still means "when this text last changed"…
			expect(new Date(after[0]?.updated_at).getTime()).toBe(
				new Date(before[0]?.updated_at).getTime(),
			);
			// …and the audit trail carries no line for a change that never happened.
			expect(lines.some((line) => line.event === "notice_template_saved")).toBe(
				false,
			);
		});

		it("still writes when one character moved", async () => {
			// The guard above must not swallow a real edit.
			const created = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "late_notice_1",
				subject: "Before",
				body: "Hello {{customer_name}}.",
			});

			const updated = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "late_notice_1",
				subject: "Before.",
				body: "Hello {{customer_name}}.",
			});

			expect(updated.subject).toBe("Before.");
			expect(updated.updatedAt.getTime()).not.toBe(created.updatedAt.getTime());
		});

		it("writes the first save even when the text is the platform default", async () => {
			// Adopting the platform's words deliberately is a different fact from
			// never having written anything: the platform copy can be revised, and a
			// purveyor who chose it should not be revised with it.
			const lines = captureLogs();

			const saved = await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "late_notice_2",
				subject: PLATFORM_DEFAULT_NOTICE_TEMPLATES.late_notice_2.subject,
				body: PLATFORM_DEFAULT_NOTICE_TEMPLATES.late_notice_2.body,
			});

			const { rows } = await pool.query(
				"select id from notice_templates where id = $1",
				[saved.id],
			);

			expect(rows).toHaveLength(1);
			expect(lines.some((line) => line.event === "notice_template_saved")).toBe(
				true,
			);

			const templates = await callerFor(
				ids.adminA,
			).notices.listNoticeTemplates();

			expect(
				templates.find((row) => row.noticeType === "late_notice_2")
					?.isCustomized,
			).toBe(true);
		});

		it("refuses an invalid notice type", async () => {
			await expect(
				callerFor(ids.adminA).notices.upsertNoticeTemplate({
					noticeType: "general_info",
					subject: "Not a type",
					body: "Hello {{customer_name}}.",
				}),
			).rejects.toThrow();
		});

		it("refuses blank subject or body", async () => {
			await expect(
				callerFor(ids.adminA).notices.upsertNoticeTemplate({
					noticeType: "reminder",
					subject: "   ",
					body: "Hello {{customer_name}}.",
				}),
			).rejects.toThrow();

			await expect(
				callerFor(ids.adminA).notices.upsertNoticeTemplate({
					noticeType: "reminder",
					subject: "Has a subject",
					body: "",
				}),
			).rejects.toThrow();
		});

		it("refuses text containing an unsupported placeholder", async () => {
			await expect(
				callerFor(ids.adminA).notices.upsertNoticeTemplate({
					noticeType: "reminder",
					subject: "Due soon",
					body: "Hello {{custmer_name}}.",
				}),
			).rejects.toThrow(/custmer_name/);
		});

		it("emits a structured audit line naming the actor, tenant and notice type", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).notices.upsertNoticeTemplate({
				noticeType: "final_notice",
				subject: "Audited save",
				body: "Hello {{customer_name}}.",
			});

			const entry = lines.find(
				(line) => line.event === "notice_template_saved",
			);

			expect(entry).toMatchObject({
				event: "notice_template_saved",
				actor_id: ids.adminA,
				wp_id: wpA,
				notice_type: "final_notice",
			});
			expect(typeof entry?.timestamp).toBe("string");
		});
	});

	describe("getBroadcastAudience", () => {
		it("counts only the caller's own tenant", async () => {
			const audience = await callerFor(ids.adminA).notices.getBroadcastAudience(
				{ recipientFilter: "all_customers" },
			);

			// Three active customers in A; the suspended one and everything in B are
			// out.
			expect(audience.recipientCount).toBe(3);
		});

		it("narrows to the agricultural rate category", async () => {
			const audience = await callerFor(ids.adminA).notices.getBroadcastAudience(
				{ recipientFilter: "agricultural_only" },
			);

			expect(audience.recipientCount).toBe(1);
		});

		it("counts a customer with two past-due assemblies once", async () => {
			const audience = await callerFor(ids.adminA).notices.getBroadcastAudience(
				{ recipientFilter: "past_due_only" },
			);

			expect(audience.recipientCount).toBe(1);
		});

		it("returns a count and nothing about any customer", async () => {
			const audience = await callerFor(ids.adminA).notices.getBroadcastAudience(
				{ recipientFilter: "all_customers" },
			);

			// No sample recipient, no preview values: the broadcast has nothing to
			// substitute, and the composer only needs to say how many.
			expect(audience).toEqual({
				recipientFilter: "all_customers",
				recipientCount: 3,
			});
		});

		it("rejects a recipient filter that is not one of the three", async () => {
			await expect(
				callerFor(ids.adminA).notices.getBroadcastAudience({
					recipientFilter: "everyone" as RecipientFilter,
				}),
			).rejects.toThrow();
		});
	});

	describe("sendGeneralInfoBroadcast", () => {
		it("writes to every active customer in the tenant and to nobody else", async () => {
			const lines = captureLogs();

			const result = await callerFor(
				ids.adminA,
			).notices.sendGeneralInfoBroadcast({
				subject: "News from {{wp_name}}",
				body: "Hello {{customer_name}}.",
				recipientFilter: "all_customers",
			});

			const recipients = deliveredTo(lines);

			expect(result).toMatchObject({ recipientCount: 3, sentCount: 3 });
			expect(recipients.sort()).toEqual([
				"ag.a@example.com",
				"pastdue.a@example.com",
				"standard.a@example.com",
			]);
			// The other tenant's customer has the same name; only the address
			// distinguishes them, which is exactly why it is asserted.
			expect(recipients).not.toContain("standard.b@example.com");
			// Product decision: a suspended customer is not written to.
			expect(recipients).not.toContain("suspended.a@example.com");
		});

		it("sends the literal subject and body, identical for every recipient", async () => {
			const lines = captureLogs();

			const result = await callerFor(
				ids.adminA,
			).notices.sendGeneralInfoBroadcast({
				subject: "Hello {{customer_name}} from {{wp_name}}",
				body: "Dear {{customer_name}}, about {{bin}} and {{nope}}.",
				recipientFilter: "all_customers",
			});

			const deliveries = lines.filter(
				(line) => line.event === "email_console_delivery",
			);

			// Braces are text on this path — known, asset-scoped or made up, none
			// is refused and none is substituted.
			expect(result.sentCount).toBe(3);
			expect(deliveries).toHaveLength(3);
			for (const delivery of deliveries) {
				expect(delivery.subject).toBe(
					"Hello {{customer_name}} from {{wp_name}}",
				);
				expect(String(delivery.html)).toContain(
					"<p>Dear {{customer_name}}, about {{bin}} and {{nope}}.</p>",
				);
				// No customer's or purveyor's name was written into anybody's copy.
				expect(String(delivery.html)).not.toContain("Shared");
				expect(String(delivery.html)).not.toContain(
					"Notices Fixture Water Works",
				);
			}
			expect(new Set(deliveries.map((line) => line.html)).size).toBe(1);
		});

		it("ignores a tenant sent in the payload", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
				subject: "Tenant from the caller",
				body: "Hello.",
				recipientFilter: "all_customers",
				waterPurveyorId: wpB,
			} as Parameters<NoticesCaller["notices"]["sendGeneralInfoBroadcast"]>[0]);

			expect(deliveredTo(lines)).not.toContain("standard.b@example.com");
			expect(deliveredTo(lines)).toHaveLength(3);
		});

		it("escapes rather than renders markup in the body", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
				subject: "Plain text only",
				body: "Hello {{customer_name}} <script>alert(1)</script>",
				recipientFilter: "agricultural_only",
			});

			const [delivery] = lines.filter(
				(line) => line.event === "email_console_delivery",
			);

			expect(String(delivery?.html)).not.toContain("<script>");
			expect(String(delivery?.html)).toContain("&lt;script&gt;");
		});

		it("renders the body inside the shared email layout", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
				subject: "In the shell",
				body: "Hello {{customer_name}}.\nSecond line.",
				recipientFilter: "agricultural_only",
			});

			const html = String(
				lines.find((line) => line.event === "email_console_delivery")?.html,
			);

			expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
			// The layout's own brand constant, so the assertion follows the brand
			// rather than restating a spelling that can drift from it.
			expect(html).toContain(`>${EMAIL_BRAND_NAME}</td>`);
			expect(html).toContain(`Sent through ${EMAIL_BRAND_NAME}.`);
			expect(html).toContain(
				"<p>Hello {{customer_name}}.</p>\n<p>Second line.</p>",
			);
		});

		it("writes once to a customer with two past-due assemblies", async () => {
			const lines = captureLogs();

			const result = await callerFor(
				ids.adminA,
			).notices.sendGeneralInfoBroadcast({
				subject: "Overdue notice from {{wp_name}}",
				body: "Hello {{customer_name}}.",
				recipientFilter: "past_due_only",
			});

			expect(result.sentCount).toBe(1);
			expect(deliveredTo(lines)).toEqual(["pastdue.a@example.com"]);
		});

		it("tags each send so delivery logs can be filtered", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
				subject: "Tagged",
				body: "Hello {{customer_name}}.",
				recipientFilter: "agricultural_only",
			});

			const attempt = lines.find(
				(line) => line.event === "email_send_attempted",
			);
			const delivery = lines.find(
				(line) => line.event === "email_console_delivery",
			);

			expect(attempt).toMatchObject({
				email_event: "general_info_broadcast",
				status: "sent",
				actor_id: ids.adminA,
				wp_id: wpA,
				recipient_id: customerIds.agriculturalA,
			});
			expect(delivery?.tags).toEqual(
				expect.arrayContaining([
					{ name: "type", value: "general_info_broadcast" },
					{ name: "recipient_filter", value: "agricultural_only" },
				]),
			);
		});

		it("refuses a blank subject or body", async () => {
			await expect(
				callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
					subject: "  ",
					body: "Hello {{customer_name}}.",
					recipientFilter: "all_customers",
				}),
			).rejects.toThrow();
		});

		it("refuses a recipient filter that is not one of the three", async () => {
			await expect(
				callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
					subject: "Everyone",
					body: "Hello {{customer_name}}.",
					recipientFilter: "everyone" as RecipientFilter,
				}),
			).rejects.toThrow();
		});

		it("logs the actor, tenant, filter and outcome", async () => {
			const lines = captureLogs();

			await callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
				subject: "Audited broadcast",
				body: "Hello {{customer_name}}.",
				recipientFilter: "agricultural_only",
			});

			expect(
				lines.find((line) => line.event === "general_info_broadcast_finished"),
			).toMatchObject({
				actor_id: ids.adminA,
				wp_id: wpA,
				recipient_filter: "agricultural_only",
				recipient_count: 1,
				sent_count: 1,
				failed_count: 0,
				status: "sent",
			});
		});

		it("does not report success when a send fails", async () => {
			const lines = captureLogs();
			const email = await import("../lib/email");
			let attempt = 0;

			// The second of three sends throws. The first has already gone out, so
			// this is the partial-failure case rather than a clean nothing-sent one.
			vi.spyOn(email.consoleDriver, "send").mockImplementation(
				async (message) => {
					attempt += 1;
					if (attempt === 2) throw new Error("provider refused the message");

					return { id: `test_${attempt}_${message.to}`, driver: "console" };
				},
			);

			await expect(
				callerFor(ids.adminA).notices.sendGeneralInfoBroadcast({
					subject: "Partly delivered",
					body: "Hello {{customer_name}}.",
					recipientFilter: "all_customers",
				}),
			).rejects.toThrow(
				/2 of 3 messages were sent and 1 failed.*would get it twice/i,
			);
			// No automatic retry: three recipients, three attempts, no fourth.
			expect(attempt).toBe(3);

			// Both outcomes are on the record, through the one email helper.
			const attempts = lines.filter(
				(line) => line.event === "email_send_attempted",
			);
			expect(attempts.filter((line) => line.status === "sent")).toHaveLength(2);
			expect(attempts.filter((line) => line.status === "failed")).toHaveLength(
				1,
			);
			expect(
				lines.find((line) => line.event === "general_info_broadcast_finished"),
			).toMatchObject({
				status: "partial_failure",
				recipient_count: 3,
				sent_count: 2,
				failed_count: 1,
			});
		});

		it("refuses an audience with nobody in it rather than reporting a send", async () => {
			const lines = captureLogs();

			// Tenant B has one active customer and no agricultural one.
			await expect(
				callerFor(ids.adminB).notices.sendGeneralInfoBroadcast({
					subject: "Nobody",
					body: "Hello {{customer_name}}.",
					recipientFilter: "agricultural_only",
				}),
			).rejects.toThrow(/no customers/i);

			expect(
				lines.filter((line) => line.event === "email_send_attempted"),
			).toEqual([]);
			expect(
				lines.find((line) => line.event === "general_info_broadcast_finished"),
			).toBeUndefined();
		});
	});
});
