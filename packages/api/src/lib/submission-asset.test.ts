import { describe, expect, it } from "vitest";

import {
	MISSING_SERVICE_ADDRESS_MESSAGE,
	MISSING_TEST_DATE_MESSAGE,
	missingAssemblyDetailsMessage,
	newAssetFromSubmission,
	noBinAssetFromSubmission,
} from "./submission-asset";

/**
 * The pure half of registering an asset from a no-BIN test: what the asset and
 * its customer are, and when a test cannot describe one. The transaction that
 * writes them is covered in `routers/submitted-tests.test.ts`.
 */

const correction = {
	bfaType: "RP" as const,
	submittedBinText: "5000",
	testDate: "2026-10-07",
	wizardData: {
		assemblyServiceAddress: " 12 Kalakaua Ave ",
		assemblyMake: "Watts",
		assemblyModel: "LF909",
		assemblySerialNumber: "SN-1",
		assemblySize: 1.5,
		assemblyLocationText: "Front yard",
		customerName: "Leilani Kahale",
		customerEmail: " Leilani@Example.com ",
		linePressure: 62,
	},
};

function planOf(input: Parameters<typeof newAssetFromSubmission>[0]) {
	const result = newAssetFromSubmission(input);

	if (!result.ok) throw new Error(result.message);

	return result.plan;
}

describe("newAssetFromSubmission", () => {
	it("builds the asset from the test's type and assembly answers", () => {
		expect(planOf(correction).asset).toEqual({
			bin: "5000",
			bfaType: "RP",
			serviceAddress: "12 Kalakaua Ave",
			make: "Watts",
			model: "LF909",
			serialNumber: "SN-1",
			size: "1.5",
			assemblyLocation: "Front yard",
			annualTestDate: "2027-10-07",
			currentCustomerId: null,
		});
	});

	it("sets the next test a year after this one, clamping 29 February", () => {
		expect(
			planOf({ ...correction, testDate: "2028-02-29" }).asset.annualTestDate,
		).toBe("2029-02-28");
	});

	it("carries the wizard's customer with the email normalised", () => {
		expect(planOf(correction).customer).toEqual({
			name: "Leilani Kahale",
			email: "leilani@example.com",
		});
	});

	it("keeps an email with no name, so an existing customer can still match", () => {
		expect(
			planOf({
				...correction,
				wizardData: { ...correction.wizardData, customerName: "  " },
			}).customer,
		).toEqual({ name: null, email: "leilani@example.com" });
	});

	it("names no customer when the wizard recorded no usable email", () => {
		for (const customerEmail of ["", "not-an-email", null]) {
			expect(
				planOf({
					...correction,
					wizardData: { ...correction.wizardData, customerEmail },
				}).customer,
			).toBeNull();
		}
	});

	it("refuses a test missing assembly details, naming each one rather than inventing them", () => {
		// Every asset needs its make, model, serial number, size and location
		// (WP/Admin feedback), so a test without them cannot register one.
		expect(
			newAssetFromSubmission({
				...correction,
				wizardData: { assemblyServiceAddress: "1 Main St" },
			}),
		).toEqual({
			ok: false,
			message: missingAssemblyDetailsMessage([
				"make",
				"model",
				"serial number",
				"size",
				"assembly location",
			]),
		});
	});

	it("refuses a test with no test date", () => {
		expect(newAssetFromSubmission({ ...correction, testDate: null })).toEqual({
			ok: false,
			message: MISSING_TEST_DATE_MESSAGE,
		});
	});

	it("refuses a test with no service address", () => {
		expect(
			newAssetFromSubmission({
				...correction,
				wizardData: { ...correction.wizardData, assemblyServiceAddress: " " },
			}),
		).toEqual({ ok: false, message: MISSING_SERVICE_ADDRESS_MESSAGE });
	});

	it("refuses an answer past the asset form's own limit", () => {
		const result = newAssetFromSubmission({
			...correction,
			wizardData: { ...correction.wizardData, assemblyMake: "x".repeat(201) },
		});

		expect(result.ok).toBe(false);
	});
});

describe("noBinAssetFromSubmission", () => {
	const submitted = {
		bfaType: correction.bfaType,
		testDate: correction.testDate,
		wizardData: correction.wizardData,
	};

	it("takes the assembly details from the test, with no BIN", () => {
		const result = noBinAssetFromSubmission(submitted);

		if (!result.ok) throw new Error(result.message);

		expect(result.asset).toMatchObject({
			bfaType: "RP",
			serviceAddress: "12 Kalakaua Ave",
			make: "Watts",
			model: "LF909",
			serialNumber: "SN-1",
			size: "1.5",
			assemblyLocation: "Front yard",
		});
		expect(result.asset).not.toHaveProperty("bin");
	});

	it("dates the next test a year after this one", () => {
		const result = noBinAssetFromSubmission(submitted);

		expect(result.ok && result.asset.annualTestDate).toBe("2027-10-07");
	});

	it("attaches no customer, whatever the wizard recorded", () => {
		const result = noBinAssetFromSubmission(submitted);

		expect(result.ok && result.asset.currentCustomerId).toBeNull();
	});

	it("refuses a test with no service address", () => {
		const result = noBinAssetFromSubmission({
			...submitted,
			wizardData: { ...correction.wizardData, assemblyServiceAddress: " " },
		});

		expect(result.ok).toBe(false);
	});
});
