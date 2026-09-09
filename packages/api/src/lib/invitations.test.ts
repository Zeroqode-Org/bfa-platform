import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	evaluateInvitation,
	type GlobalRole,
	type InvitingCaller,
	invitationExpiry,
	resolveInvitationTarget,
	sendInvitationEmail,
} from "./invitations";

const WP_A = "11111111-1111-4111-8111-111111111111";
const WP_B = "22222222-2222-4222-8222-222222222222";

function caller(globalRole: GlobalRole, waterPurveyorId: string | null = null) {
	return {
		profileId: "profile-1",
		globalRole,
		waterPurveyorId,
	} satisfies InvitingCaller;
}

function reject(fn: () => unknown, code: string) {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe(code);
		return;
	}

	throw new Error(`Expected a ${code} error, but the call succeeded`);
}

describe("resolveInvitationTarget — role permissions", () => {
	it("lets every WP role invite into their own purveyor", () => {
		for (const role of ["wp_admin", "wp_sub_admin", "wp_employee"] as const) {
			expect(
				resolveInvitationTarget(caller(role, WP_A), { role: "certifier" }),
			).toEqual({ associatedWpId: WP_A, proposedWaterPurveyorName: null });
		}
	});

	it("refuses a certifier outright", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("certifier"), { role: "wp_employee" }),
			"FORBIDDEN",
		);
	});

	it("refuses a WP role with no purveyor of their own", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("wp_admin", null), {
					role: "wp_employee",
				}),
			"FORBIDDEN",
		);
	});
});

describe("resolveInvitationTarget — tenant authorization", () => {
	it("ignores nothing and rejects a purveyor id that is not the caller's", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("wp_admin", WP_A), {
					role: "wp_employee",
					waterPurveyorId: WP_B,
				}),
			"FORBIDDEN",
		);
	});

	it("takes the tenant from the caller's profile, never from the input", () => {
		expect(
			resolveInvitationTarget(caller("wp_employee", WP_A), {
				role: "certifier",
				waterPurveyorId: WP_A,
			}),
		).toEqual({ associatedWpId: WP_A, proposedWaterPurveyorName: null });
	});

	it("refuses a WP role trying to provision a brand-new purveyor", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("wp_admin", WP_A), {
					role: "wp_admin",
					waterPurveyorId: null,
				}),
			"FORBIDDEN",
		);
	});

	it("refuses a WP role that so much as names a purveyor to create", () => {
		for (const role of ["wp_admin", "wp_sub_admin", "wp_employee"] as const) {
			reject(
				() =>
					resolveInvitationTarget(caller(role, WP_A), {
						role: "wp_admin",
						proposedWaterPurveyorName: "Sneaky Water District",
					}),
				"FORBIDDEN",
			);
		}
	});

	it("refuses a certifier naming a purveyor to create", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("certifier"), {
					role: "wp_admin",
					proposedWaterPurveyorName: "Sneaky Water District",
				}),
			"FORBIDDEN",
		);
	});

	it("lets a Super-Admin provision a new purveyor with a null WP", () => {
		expect(
			resolveInvitationTarget(caller("super_admin"), {
				role: "wp_admin",
				proposedWaterPurveyorName: "Riverside Water District",
			}),
		).toEqual({
			associatedWpId: null,
			proposedWaterPurveyorName: "Riverside Water District",
		});

		expect(
			resolveInvitationTarget(caller("super_admin"), {
				role: "wp_admin",
				waterPurveyorId: null,
				proposedWaterPurveyorName: "  Riverside Water District  ",
			}),
		).toEqual({
			associatedWpId: null,
			proposedWaterPurveyorName: "Riverside Water District",
		});
	});

	it("lets a Super-Admin invite into any existing purveyor", () => {
		expect(
			resolveInvitationTarget(caller("super_admin"), {
				role: "wp_employee",
				waterPurveyorId: WP_B,
			}),
		).toEqual({ associatedWpId: WP_B, proposedWaterPurveyorName: null });
	});

	it("refuses a null purveyor for any role but wp_admin", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("super_admin"), {
					role: "wp_employee",
					proposedWaterPurveyorName: "Riverside Water District",
				}),
			"BAD_REQUEST",
		);
	});

	it("refuses a certifier invitation with no purveyor to authorize against", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("super_admin"), {
					role: "certifier",
					waterPurveyorId: null,
				}),
			"BAD_REQUEST",
		);
	});
});

describe("resolveInvitationTarget — the purveyor name", () => {
	it("requires a name on an invitation that creates a purveyor", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("super_admin"), { role: "wp_admin" }),
			"BAD_REQUEST",
		);
	});

	it("treats a blank name as no name at all", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("super_admin"), {
					role: "wp_admin",
					proposedWaterPurveyorName: "   ",
				}),
			"BAD_REQUEST",
		);
	});

	it("refuses a name on an invitation into an existing purveyor", () => {
		reject(
			() =>
				resolveInvitationTarget(caller("super_admin"), {
					role: "wp_employee",
					waterPurveyorId: WP_B,
					proposedWaterPurveyorName: "Riverside Water District",
				}),
			"BAD_REQUEST",
		);
	});
});

describe("evaluateInvitation", () => {
	const now = new Date("2026-06-01T00:00:00.000Z");
	const base = {
		status: "pending" as const,
		isRedeemed: false,
		expiresAt: new Date("2026-06-08T00:00:00.000Z"),
	};

	it("accepts a pending, unexpired invitation", () => {
		expect(evaluateInvitation(base, now)).toBe("valid");
	});

	it("reports a missing row as not_found", () => {
		expect(evaluateInvitation(null, now)).toBe("not_found");
		expect(evaluateInvitation(undefined, now)).toBe("not_found");
	});

	it("reports an expiry in the past, and treats the exact instant as expired", () => {
		expect(
			evaluateInvitation({ ...base, expiresAt: new Date("2026-05-31") }, now),
		).toBe("expired");
		expect(evaluateInvitation({ ...base, expiresAt: now }, now)).toBe(
			"expired",
		);
	});

	it("reports a redeemed invitation from either column on its own", () => {
		expect(evaluateInvitation({ ...base, isRedeemed: true }, now)).toBe(
			"redeemed",
		);
		expect(evaluateInvitation({ ...base, status: "redeemed" }, now)).toBe(
			"redeemed",
		);
	});

	it("prefers redeemed over expired when a row is both", () => {
		expect(
			evaluateInvitation(
				{
					status: "expired",
					isRedeemed: true,
					expiresAt: new Date("2026-05-01"),
				},
				now,
			),
		).toBe("redeemed");
	});

	it("reports a status marked expired even while the timestamp is in the future", () => {
		expect(evaluateInvitation({ ...base, status: "expired" }, now)).toBe(
			"expired",
		);
	});
});

describe("invitationExpiry", () => {
	it("defaults to a week out", () => {
		const now = new Date("2026-06-01T00:00:00.000Z");

		expect(invitationExpiry(undefined, now).toISOString()).toBe(
			"2026-06-08T00:00:00.000Z",
		);
	});
});

describe("sendInvitationEmail", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("puts a working invite link in the console output", async () => {
		const lines: Record<string, unknown>[] = [];
		vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(JSON.parse(String(value)));
		});

		const result = await sendInvitationEmail({
			invitationId: "invite-1",
			email: "invitee@example.com",
			role: "certifier",
			secret: "s3cret-token",
			expiresAt: new Date("2026-06-08T00:00:00.000Z"),
			waterPurveyorName: "Harbor Water Works",
			associatedWpId: WP_A,
			invitedByProfileId: "profile-1",
		});

		const delivery = lines.find(
			(line) => line.event === "email_console_delivery",
		);

		expect(delivery).toBeDefined();
		expect(String(delivery?.html)).toContain(result.inviteLink);
		expect(result.inviteLink).toContain("/invite/s3cret-token");
		expect(delivery?.to).toBe("invitee@example.com");

		const attempt = lines.find((line) => line.event === "email_send_attempted");

		expect(attempt).toMatchObject({
			email_event: "invitation_created",
			status: "sent",
			invitation_id: "invite-1",
			wp_id: WP_A,
			actor_id: "profile-1",
		});
	});

	it("escapes the purveyor name rather than injecting it into the markup", async () => {
		const lines: Record<string, unknown>[] = [];
		vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			lines.push(JSON.parse(String(value)));
		});

		await sendInvitationEmail({
			invitationId: "invite-2",
			email: "invitee@example.com",
			role: "wp_employee",
			secret: "another-token",
			expiresAt: new Date("2026-06-08T00:00:00.000Z"),
			waterPurveyorName: '<script>alert("x")</script>',
			associatedWpId: WP_A,
			invitedByProfileId: "profile-1",
		});

		const html = String(
			lines.find((line) => line.event === "email_console_delivery")?.html,
		);

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
