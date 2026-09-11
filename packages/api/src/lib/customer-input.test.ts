import { describe, expect, it } from "vitest";

import {
	createCustomerInput,
	customerColumns,
	updateCustomerInput,
} from "./customer-input";

/**
 * The customer input rules on their own — no database, no tRPC caller.
 *
 * These are the rules a client cannot be trusted to have applied: that a name
 * of spaces is empty, that an agricultural customer has a renewal date to
 * notice against, and that a standard one cannot smuggle one in. The
 * tenant-boundary half of the story is in `routers/customers.test.ts`, which
 * needs a real database and runs only under `npm run test:db`.
 */

const standard = {
	name: "Marta Ellison",
	email: "marta@example.com",
	rateCategory: "standard" as const,
	status: "active" as const,
};

const agricultural = {
	name: "Ridgeline Orchards",
	email: "billing@ridgeline.example",
	rateCategory: "agricultural" as const,
	agRenewalDate: "2027-03-01",
	status: "active" as const,
};

describe("createCustomerInput", () => {
	it("accepts a minimal standard customer and defaults the status to active", () => {
		const parsed = createCustomerInput.parse({
			name: "Marta Ellison",
			email: "marta@example.com",
			rateCategory: "standard",
		});

		expect(parsed.status).toBe("active");
		expect(parsed.accountNumber).toBeNull();
		expect(parsed.address).toBeNull();
	});

	it("rejects a name that is only whitespace", () => {
		expect(
			createCustomerInput.safeParse({ ...standard, name: "   " }).success,
		).toBe(false);
	});

	it("trims the name it keeps", () => {
		const parsed = createCustomerInput.parse({
			...standard,
			name: "  Marta Ellison  ",
		});

		expect(parsed.name).toBe("Marta Ellison");
	});

	it("rejects an address that is not an email", () => {
		expect(
			createCustomerInput.safeParse({ ...standard, email: "marta@" }).success,
		).toBe(false);
		expect(
			createCustomerInput.safeParse({ ...standard, email: "" }).success,
		).toBe(false);
	});

	it("normalises the email to lowercase, so one address has one spelling", () => {
		const parsed = createCustomerInput.parse({
			...standard,
			email: "  Marta@Example.COM ",
		});

		expect(parsed.email).toBe("marta@example.com");
	});

	it("collapses a blank optional field to null rather than storing an empty string", () => {
		const parsed = createCustomerInput.parse({
			...standard,
			accountNumber: "   ",
			address: "",
		});

		expect(parsed.accountNumber).toBeNull();
		expect(parsed.address).toBeNull();
	});

	it("requires an AG renewal date on the agricultural rate", () => {
		expect(
			createCustomerInput.safeParse({
				name: agricultural.name,
				email: agricultural.email,
				rateCategory: "agricultural",
			}).success,
		).toBe(false);

		expect(
			createCustomerInput.safeParse({ ...agricultural, agRenewalDate: "" })
				.success,
		).toBe(false);

		expect(
			createCustomerInput.safeParse({
				...agricultural,
				agRenewalDate: "March 2027",
			}).success,
		).toBe(false);
	});

	it("accepts an agricultural customer with a renewal date", () => {
		const parsed = createCustomerInput.parse(agricultural);

		expect(parsed).toMatchObject({
			rateCategory: "agricultural",
			agRenewalDate: "2027-03-01",
		});
	});

	it("refuses a renewal date on the standard rate rather than ignoring it", () => {
		expect(
			createCustomerInput.safeParse({
				...standard,
				agRenewalDate: "2027-03-01",
			}).success,
		).toBe(false);
	});

	it("accepts an explicit null renewal date on the standard rate", () => {
		// What the edit form sends when a customer moves off the agricultural rate.
		expect(
			createCustomerInput.safeParse({ ...standard, agRenewalDate: null })
				.success,
		).toBe(true);
	});

	it("has no field in which to name a water purveyor", () => {
		const parsed = createCustomerInput.parse({
			...standard,
			waterPurveyorId: "00000000-0000-4000-8000-000000000000",
		}) as Record<string, unknown>;

		// Zod strips it: the tenant comes from the caller's profile, and a client
		// that sends one is sending a field the server never reads.
		expect(parsed.waterPurveyorId).toBeUndefined();
	});
});

describe("updateCustomerInput", () => {
	it("requires the row id", () => {
		expect(updateCustomerInput.safeParse(standard).success).toBe(false);
		expect(
			updateCustomerInput.safeParse({ ...standard, id: "not-a-uuid" }).success,
		).toBe(false);
	});

	it("carries the same rate-category rules as create", () => {
		const id = "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607";

		expect(
			updateCustomerInput.safeParse({
				...standard,
				id,
				agRenewalDate: "2027-03-01",
			}).success,
		).toBe(false);

		expect(
			updateCustomerInput.safeParse({
				...agricultural,
				id,
				agRenewalDate: undefined,
			}).success,
		).toBe(false);
	});
});

describe("customerColumns", () => {
	it("stores the renewal date for an agricultural customer", () => {
		expect(
			customerColumns(createCustomerInput.parse(agricultural)),
		).toMatchObject({
			rateCategory: "agricultural",
			agRenewalDate: "2027-03-01",
		});
	});

	it("writes a null renewal date for a standard customer", () => {
		// The column is cleared on the way back to the standard rate, so a
		// customer who leaves the agricultural rate does not keep a stale date
		// that the AG renewal notice would later fire against.
		expect(
			customerColumns(
				createCustomerInput.parse({ ...standard, agRenewalDate: null }),
			).agRenewalDate,
		).toBeNull();
	});
});
