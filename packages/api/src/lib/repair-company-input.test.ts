import { describe, expect, it } from "vitest";

import {
	createRepairCompanyInput,
	repairCompanyColumns,
	updateRepairCompanyInput,
} from "./repair-company-input";
import { US_PHONE_MESSAGE } from "./us-phone";

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
	phone: "(555) 014-2233",
	email: "dispatch@ridgeline.example",
	status: "active" as const,
};

const ROW_ID = "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607";

/** Both write shapes, so every phone rule is asserted on create and on update. */
const WRITE_SHAPES = [
	{
		name: "createRepairCompanyInput",
		parse: (phone: unknown) =>
			createRepairCompanyInput.safeParse({ ...company, phone }),
	},
	{
		name: "updateRepairCompanyInput",
		parse: (phone: unknown) =>
			updateRepairCompanyInput.safeParse({ ...company, id: ROW_ID, phone }),
	},
] as const;

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

describe.each(WRITE_SHAPES)("phone on $name", ({ parse }) => {
	it("accepts a valid US number however it is punctuated, and stores (XXX) XXX-XXXX", () => {
		for (const phone of [
			"(555) 123-4567",
			"555-123-4567",
			"5551234567",
			"555.123.4567",
			"  555 123 4567 ",
			"+1 555 123 4567",
			"+15551234567",
			"1-555-123-4567",
		]) {
			const parsed = parse(phone);

			expect(parsed.success).toBe(true);
			expect(parsed.data?.phone).toBe("(555) 123-4567");
		}
	});

	it("accepts blank, whitespace and null as no phone at all", () => {
		for (const phone of ["", "   ", null, undefined]) {
			const parsed = parse(phone);

			expect(parsed.success).toBe(true);
			expect(parsed.data?.phone).toBeNull();
		}
	});

	it("refuses short, long, lettered, extended and malformed numbers without rewriting them", () => {
		for (const phone of [
			"555-0142",
			"555123456",
			"55512345678",
			"+2 555 123 4567",
			"555-123-45678",
			"555-CALL-NOW",
			"555-123-4567 x12",
			"555-123-4567 ext. 12",
			"(555) 0142 x12",
			"++1 555 123 4567",
			"555_123_4567",
			"555/123/4567",
			"phone",
			"1".repeat(51),
		]) {
			const parsed = parse(phone);

			expect(parsed.success, phone).toBe(false);
		}
	});

	it("says what a phone has to be", () => {
		const parsed = parse("555-0142");

		expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
			US_PHONE_MESSAGE,
		);
		expect(parsed.error?.issues[0]?.path).toEqual(["phone"]);
	});
});

describe("a stored legacy phone", () => {
	// A row written before the phone rule, exactly as the edit dialog sends it
	// back: every field, unchanged.
	const legacyRow = {
		id: ROW_ID,
		companyName: "Legacy Backflow Repair",
		phone: "555-0142",
		email: "legacy@example.com",
		status: "active" as const,
	};

	it("cannot be saved unchanged", () => {
		const parsed = updateRepairCompanyInput.safeParse(legacyRow);

		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toBe(US_PHONE_MESSAGE);
	});

	it("saves once the phone is corrected, in the canonical format", () => {
		expect(
			updateRepairCompanyInput.parse({ ...legacyRow, phone: "555 014 2000" })
				.phone,
		).toBe("(555) 014-2000");
	});

	it("saves once the phone is cleared", () => {
		expect(
			updateRepairCompanyInput.parse({ ...legacyRow, phone: "" }).phone,
		).toBeNull();
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
