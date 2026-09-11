import { describe, expect, it } from "vitest";

import { ASSET_FIELD_LIMITS } from "./asset-field-limits";
import {
	assetColumns,
	assignCustomerInput,
	createAssetInput,
	listAssetsInput,
	updateAssetInput,
} from "./asset-input";

/**
 * The asset input rules on their own — no database, no tRPC caller.
 *
 * These are the rules a client cannot be trusted to have applied: that a BIN of
 * spaces is empty, that an assembly without an annual test date is an asset the
 * reminder workflow could never fire for, and that neither the tenant nor the
 * scheduler-owned status can be sent in. The tenant-boundary half of the story
 * is in `routers/assets.test.ts`, which needs a real database and runs only
 * under `npm run test:db`.
 */

const asset = {
	bin: "BIN-10041",
	bfaType: "RP" as const,
	serviceAddress: "18 Canal Road",
	annualTestDate: "2027-04-01",
};

describe("createAssetInput", () => {
	it("accepts a minimal asset and nulls every optional field", () => {
		const parsed = createAssetInput.parse(asset);

		expect(parsed).toMatchObject({
			bin: "BIN-10041",
			bfaType: "RP",
			serviceAddress: "18 Canal Road",
			annualTestDate: "2027-04-01",
			make: null,
			model: null,
			serialNumber: null,
			size: null,
			assemblyLocation: null,
		});
	});

	it("rejects a BIN that is only whitespace", () => {
		expect(createAssetInput.safeParse({ ...asset, bin: "   " }).success).toBe(
			false,
		);
	});

	it("trims the BIN it keeps", () => {
		expect(createAssetInput.parse({ ...asset, bin: "  BIN-10041  " }).bin).toBe(
			"BIN-10041",
		);
	});

	it("rejects a service address that is only whitespace", () => {
		expect(
			createAssetInput.safeParse({ ...asset, serviceAddress: " " }).success,
		).toBe(false);
	});

	it("requires an annual test date — the reminder schedule is built from it", () => {
		const { annualTestDate, ...withoutDate } = asset;

		expect(createAssetInput.safeParse(withoutDate).success).toBe(false);
		expect(annualTestDate).toBe("2027-04-01");
	});

	it("rejects a date that is not a calendar date", () => {
		expect(
			createAssetInput.safeParse({ ...asset, annualTestDate: "next April" })
				.success,
		).toBe(false);
	});

	it("accepts all eight assembly types and nothing else", () => {
		for (const bfaType of [
			"RP",
			"RPDA",
			"RPDA-2",
			"DC",
			"DCDA",
			"DCDA-2",
			"PVB",
			"SVB",
		]) {
			expect(createAssetInput.safeParse({ ...asset, bfaType }).success).toBe(
				true,
			);
		}

		expect(
			createAssetInput.safeParse({ ...asset, bfaType: "RPZ" }).success,
		).toBe(false);
	});

	it("collapses a cleared optional field to null rather than an empty string", () => {
		const parsed = createAssetInput.parse({ ...asset, make: "  ", model: "" });

		expect(parsed.make).toBeNull();
		expect(parsed.model).toBeNull();
	});

	it("treats the first occupant as optional, defaulting to nobody", () => {
		expect(createAssetInput.parse(asset).currentCustomerId).toBeNull();
		expect(
			createAssetInput.parse({ ...asset, currentCustomerId: null })
				.currentCustomerId,
		).toBeNull();
	});

	it("keeps a chosen first occupant", () => {
		expect(
			createAssetInput.parse({
				...asset,
				currentCustomerId: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
			}).currentCustomerId,
		).toBe("8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607");
	});

	it("refuses a first occupant that is not a uuid", () => {
		expect(
			createAssetInput.safeParse({ ...asset, currentCustomerId: "42" }).success,
		).toBe(false);
	});

	it("refuses text past the shared field limits, and accepts text at them", () => {
		// The same numbers the form puts on its `maxLength` attributes, so the
		// browser stops typing exactly where the server stops accepting.
		for (const [field, limit] of Object.entries(ASSET_FIELD_LIMITS)) {
			expect(
				createAssetInput.safeParse({ ...asset, [field]: "x".repeat(limit) })
					.success,
			).toBe(true);
			expect(
				createAssetInput.safeParse({ ...asset, [field]: "x".repeat(limit + 1) })
					.success,
			).toBe(false);
		}
	});
});

describe("assignCustomerInput", () => {
	const ids = {
		assetId: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		customerId: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
	};

	it("defaults the suspended acknowledgement to false", () => {
		// A client that has never heard of the flag must get the refusal, not the
		// silently paused asset.
		expect(assignCustomerInput.parse(ids).acknowledgeSuspendedCustomer).toBe(
			false,
		);
	});

	it("carries the acknowledgement when it is sent", () => {
		expect(
			assignCustomerInput.parse({
				...ids,
				acknowledgeSuspendedCustomer: true,
			}).acknowledgeSuspendedCustomer,
		).toBe(true);
	});

	it("refuses ids that are not uuids", () => {
		expect(
			assignCustomerInput.safeParse({ ...ids, customerId: "42" }).success,
		).toBe(false);
	});
});

describe("assetColumns", () => {
	it("writes neither the tenant, the status nor the current customer", () => {
		// The three columns a client must not be able to move: the tenant comes
		// from the caller's profile, the status from the scheduler, and the
		// customer from `assignCustomer`, which records the occupancy change.
		const columns = assetColumns(
			createAssetInput.parse({
				...asset,
				waterPurveyorId: "10000000-0000-4000-8000-000000000002",
				assetStatus: "past_due",
				currentCustomerId: "10000000-0000-4000-8000-000000000041",
			} as never),
		);

		expect(Object.keys(columns).sort()).toEqual([
			"annualTestDate",
			"assemblyLocation",
			"bfaType",
			"bin",
			"make",
			"model",
			"serialNumber",
			"serviceAddress",
			"size",
		]);
	});
});

describe("updateAssetInput", () => {
	it("takes the whole record plus the row id", () => {
		const parsed = updateAssetInput.parse({
			...asset,
			id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		});

		expect(parsed.id).toBe("1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9");
	});

	it("accepts a changed BIN — correcting one is allowed, and logged elsewhere", () => {
		const parsed = updateAssetInput.parse({
			...asset,
			bin: "BIN-20099",
			id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
		});

		expect(parsed.bin).toBe("BIN-20099");
	});

	it("refuses an id that is not a uuid", () => {
		expect(updateAssetInput.safeParse({ ...asset, id: "42" }).success).toBe(
			false,
		);
	});

	it("does not carry a customer, even when one is sent", () => {
		// Moving the occupant of an existing asset has to close the outgoing
		// assignment in the same transaction — `assignCustomer`'s job. A field
		// here would be the one way to change an occupant without recording it.
		const parsed = updateAssetInput.parse({
			...asset,
			id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
			currentCustomerId: "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607",
		});

		expect(Object.keys(parsed)).not.toContain("currentCustomerId");
	});
});

describe("listAssetsInput", () => {
	it("defaults to the first page with no filters", () => {
		const parsed = listAssetsInput.parse(undefined);

		expect(parsed).toMatchObject({ page: 1, pageSize: 25 });
		expect(parsed.status).toBeUndefined();
		expect(parsed.search).toBeUndefined();
	});

	it("treats a blank search box as no filter at all", () => {
		expect(listAssetsInput.parse({ search: "   " }).search).toBeUndefined();
	});

	it("trims a real search term", () => {
		expect(listAssetsInput.parse({ search: " canal " }).search).toBe("canal");
	});

	it("refuses a status outside the three the scheduler computes", () => {
		expect(listAssetsInput.safeParse({ status: "overdue" }).success).toBe(
			false,
		);
		expect(listAssetsInput.safeParse({ status: "past_due" }).success).toBe(
			true,
		);
	});

	it("caps the page size, so one request cannot ask for the whole table", () => {
		expect(listAssetsInput.safeParse({ pageSize: 500 }).success).toBe(false);
	});
});
