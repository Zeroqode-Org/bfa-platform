import { describe, expect, it } from "vitest";

import {
	createRepairCompanyInput,
	repairCompanyColumns,
	updateRepairCompanyInput,
} from "./repair-company-input";

/**
 * The repair-company input rules on their own — no database, no tRPC caller.
 *
 * These are the rules a client cannot be trusted to have applied: that a
 * company name of spaces is empty, that a blank contact field is NULL rather
 * than `''`, and that an address which *is* given has to be an address. The
 * tenant-boundary half of the story is in `routers/repair-companies.test.ts`,
 * which needs a real database and runs only under `npm run test:db`.
 */

const company = {
	companyName: "Ridgeline Backflow Repair",
	phone: "555-0142",
	email: "dispatch@ridgeline.example",
	status: "active" as const,
};

describe("createRepairCompanyInput", () => {
	it("accepts a company with nothing but a name, and defaults the status to active", () => {
		const parsed = createRepairCompanyInput.parse({
			companyName: "Ridgeline Backflow Repair",
		});

		expect(parsed.status).toBe("active");
		// Reachable by neither column yet is a real record — the PRD makes both
		// contact fields optional.
		expect(parsed.phone).toBeNull();
		expect(parsed.email).toBeNull();
	});

	it("rejects a company name that is only whitespace", () => {
		expect(
			createRepairCompanyInput.safeParse({ ...company, companyName: "   " })
				.success,
		).toBe(false);
		expect(
			createRepairCompanyInput.safeParse({ ...company, companyName: "" })
				.success,
		).toBe(false);
	});

	it("trims the company name it keeps", () => {
		expect(
			createRepairCompanyInput.parse({
				...company,
				companyName: "  Ridgeline Backflow Repair  ",
			}).companyName,
		).toBe("Ridgeline Backflow Repair");
	});

	it("collapses a blank contact field to null rather than storing an empty string", () => {
		// What the form sends for a field that was typed into and then cleared.
		const parsed = createRepairCompanyInput.parse({
			...company,
			phone: "   ",
			email: "",
		});

		expect(parsed.phone).toBeNull();
		expect(parsed.email).toBeNull();
	});

	it("accepts an explicit null for either contact field", () => {
		const parsed = createRepairCompanyInput.parse({
			...company,
			phone: null,
			email: null,
		});

		expect(parsed).toMatchObject({ phone: null, email: null });
	});

	it("rejects an email that is not an email, once one is given at all", () => {
		// Optional does not mean unvalidated: an address that is present goes into
		// a failure notice, so a typo is a repair company nobody can reach.
		for (const email of ["dispatch@", "dispatch", "@ridgeline.example"]) {
			expect(
				createRepairCompanyInput.safeParse({ ...company, email }).success,
			).toBe(false);
		}
	});

	it("normalises the email to lowercase, so one address has one spelling", () => {
		expect(
			createRepairCompanyInput.parse({
				...company,
				email: "  Dispatch@Ridgeline.EXAMPLE ",
			}).email,
		).toBe("dispatch@ridgeline.example");
	});

	it("keeps the phone as typed apart from the surrounding space", () => {
		// No format is imposed: a WP writes extensions, country codes and pager
		// numbers the way their own records already spell them.
		expect(
			createRepairCompanyInput.parse({ ...company, phone: "  (555) 0142 x12 " })
				.phone,
		).toBe("(555) 0142 x12");
	});

	it("takes only the two statuses the screen offers", () => {
		expect(
			createRepairCompanyInput.parse({ ...company, status: "inactive" }).status,
		).toBe("inactive");
		expect(
			createRepairCompanyInput.safeParse({ ...company, status: "suspended" })
				.success,
		).toBe(false);
		// No deletion anywhere: there is no status that means "gone".
		expect(
			createRepairCompanyInput.safeParse({ ...company, status: "deleted" })
				.success,
		).toBe(false);
	});

	it("has no field in which to name a water purveyor", () => {
		const parsed = createRepairCompanyInput.parse({
			...company,
			waterPurveyorId: "00000000-0000-4000-8000-000000000000",
		}) as Record<string, unknown>;

		// Zod strips it: the tenant comes from the caller's profile, and a client
		// that sends one is sending a field the server never reads.
		expect(parsed.waterPurveyorId).toBeUndefined();
	});
});

describe("updateRepairCompanyInput", () => {
	it("requires the row id", () => {
		expect(updateRepairCompanyInput.safeParse(company).success).toBe(false);
		expect(
			updateRepairCompanyInput.safeParse({ ...company, id: "not-a-uuid" })
				.success,
		).toBe(false);
	});

	it("carries the same field rules as create", () => {
		const id = "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607";

		expect(
			updateRepairCompanyInput.safeParse({ ...company, id, companyName: " " })
				.success,
		).toBe(false);
		expect(
			updateRepairCompanyInput.safeParse({ ...company, id, email: "nope" })
				.success,
		).toBe(false);
		expect(
			updateRepairCompanyInput.parse({ ...company, id, phone: "" }).phone,
		).toBeNull();
	});

	it("has no field in which to name a water purveyor either", () => {
		const parsed = updateRepairCompanyInput.parse({
			...company,
			id: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
			waterPurveyorId: "00000000-0000-4000-8000-000000000000",
		}) as Record<string, unknown>;

		expect(parsed.waterPurveyorId).toBeUndefined();
	});
});

describe("repairCompanyColumns", () => {
	it("writes exactly the four editable columns, and no tenant", () => {
		expect(
			Object.keys(
				repairCompanyColumns(createRepairCompanyInput.parse(company)),
			).sort(),
		).toEqual(["companyName", "email", "phone", "status"]);
	});

	it("carries the normalised values through", () => {
		expect(
			repairCompanyColumns(
				createRepairCompanyInput.parse({
					companyName: "  Ridgeline Backflow Repair ",
					phone: "",
					email: " Dispatch@Ridgeline.EXAMPLE ",
					status: "inactive",
				}),
			),
		).toEqual({
			companyName: "Ridgeline Backflow Repair",
			phone: null,
			email: "dispatch@ridgeline.example",
			status: "inactive",
		});
	});
});
