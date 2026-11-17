import { describe, expect, it, vi } from "vitest";

vi.mock("@bfa-platform/db", () => ({ db: {} }));

const { comparableName, pickCustomer } = await import("./customer-match");
const { oneRecipientPerInbox } = await import("./notice-recipients");

const iolani = {
	id: "c1",
	name: "Iolani School",
	status: "active" as const,
};
const punahou = {
	id: "c2",
	name: "Punahou School",
	status: "active" as const,
};

/**
 * The email is the key; the name only tells apart customers who share it.
 */
describe("pickCustomer", () => {
	it("finds nobody when nobody uses the email", () => {
		expect(pickCustomer([], "Iolani School")).toEqual({ kind: "none" });
	});

	it("takes the only customer on the email, whatever name the test gives", () => {
		// The WP renamed them since; a second copy must not be created.
		expect(pickCustomer([iolani], "Iolani Prep")).toEqual({
			kind: "match",
			customer: iolani,
		});
		expect(pickCustomer([iolani], null)).toEqual({
			kind: "match",
			customer: iolani,
		});
	});

	it("tells a shared inbox's customers apart by name", () => {
		expect(pickCustomer([iolani, punahou], "  punahou   SCHOOL ")).toEqual({
			kind: "match",
			customer: punahou,
		});
	});

	it("chooses nobody when a shared inbox's customers cannot be told apart", () => {
		expect(pickCustomer([iolani, punahou], "Mid-Pacific")).toEqual({
			kind: "ambiguous",
			candidates: 2,
		});
		expect(pickCustomer([iolani, punahou], null)).toEqual({
			kind: "ambiguous",
			candidates: 2,
		});
		// Two customers with the same name on one inbox: still not a choice.
		expect(
			pickCustomer([iolani, { ...iolani, id: "c3" }], "Iolani School"),
		).toEqual({ kind: "ambiguous", candidates: 2 });
	});
});

describe("comparableName", () => {
	it("ignores case, outer spaces and repeated spaces", () => {
		expect(comparableName("  McDonald's   Store 1 ")).toBe(
			"mcdonald's store 1",
		);
	});
});

describe("oneRecipientPerInbox", () => {
	it("keeps the first customer per address, compared as stored", () => {
		expect(
			oneRecipientPerInbox([
				{ id: "a", email: "office@example.com" },
				{ id: "b", email: " Office@Example.com" },
				{ id: "c", email: "other@example.com" },
			]),
		).toEqual([
			{ id: "a", email: "office@example.com" },
			{ id: "c", email: "other@example.com" },
		]);
	});
});
