import { describe, expect, it } from "vitest";

import {
	ASSET_STALE_DATE_MESSAGE,
	isStaleAssetDateError,
	resolveAnnualTestDate,
} from "./asset-stale";

describe("resolveAnnualTestDate", () => {
	it("writes the submitted date when the caller sent no expectation", () => {
		expect(
			resolveAnnualTestDate({
				stored: "2027-09-01",
				opened: undefined,
				submitted: "2023-09-01",
			}),
		).toEqual({ ok: true, date: "2023-09-01" });
	});

	it("writes the submitted date when nothing moved underneath", () => {
		expect(
			resolveAnnualTestDate({
				stored: "2023-09-01",
				opened: "2023-09-01",
				submitted: "2024-01-15",
			}),
		).toEqual({ ok: true, date: "2024-01-15" });
	});

	it("keeps a date a passing test moved when the form left it untouched", () => {
		expect(
			resolveAnnualTestDate({
				stored: "2027-09-01",
				opened: "2023-09-01",
				submitted: "2023-09-01",
			}),
		).toEqual({ ok: true, date: "2027-09-01" });
	});

	it("accepts a form that changed the date to what is now stored", () => {
		expect(
			resolveAnnualTestDate({
				stored: "2027-09-01",
				opened: "2023-09-01",
				submitted: "2027-09-01",
			}),
		).toEqual({ ok: true, date: "2027-09-01" });
	});

	it("refuses a form that changed the date while it moved underneath", () => {
		expect(
			resolveAnnualTestDate({
				stored: "2027-09-01",
				opened: "2023-09-01",
				submitted: "2024-03-01",
			}),
		).toEqual({ ok: false });
	});
});

describe("isStaleAssetDateError", () => {
	it("tells the moved-date conflict from a duplicate BIN", () => {
		expect(
			isStaleAssetDateError({
				message: ASSET_STALE_DATE_MESSAGE,
				data: { code: "CONFLICT" },
			}),
		).toBe(true);
		expect(
			isStaleAssetDateError({
				message: "BIN X is already in use by another asset",
				data: { code: "CONFLICT" },
			}),
		).toBe(false);
	});
});
