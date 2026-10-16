import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import {
	ASSEMBLY_FIELD_KEYS,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	OWNER_ABSENT_DISCLAIMER,
	WATER_METER_END_KEY,
	WATER_METER_START_KEY,
	WIZARD_TEST_SPEC,
	wizardQuestionsFor,
} from "../wizard-input";
import { resultDocumentFileName, resultDocumentTitle } from "./document-name";
import { ResultDocument } from "./frame";
import { TestBlockForTypePdf } from "./test-blocks";

type BfaType = keyof typeof WIZARD_TEST_SPEC;

/** A fully answered test for one type: every question Yes with a value, then Pass. */
function sampleData(bfaType: BfaType): Record<string, unknown> {
	const data: Record<string, unknown> = {
		[ASSEMBLY_FIELD_KEYS.serviceAddress]: "18 Canary Road",
		[ASSEMBLY_FIELD_KEYS.make]: "Watts",
		[ASSEMBLY_FIELD_KEYS.model]: "009M2",
		[ASSEMBLY_FIELD_KEYS.serialNumber]: "321-123",
		[ASSEMBLY_FIELD_KEYS.size]: "2 in",
		[ASSEMBLY_FIELD_KEYS.location]: "Front yard",
		[CUSTOMER_NAME_KEY]: "Kanye West",
		[CUSTOMER_EMAIL_KEY]: "kanye@west.com",
		[INITIAL_TEST_KEY]: "pass",
		[ISOLATES_PROPERTY_KEY]: "undetermined",
		comments: "Tested without issues.",
		adp: "12",
		linePressure: "60",
		[WATER_METER_START_KEY]: "55",
		[WATER_METER_END_KEY]: "100",
	};

	for (const entry of wizardQuestionsFor(bfaType)) {
		data[entry.key] = true;
		if (entry.valueKey) data[entry.valueKey] = "3.2";
	}

	return data;
}

/** A real 1×1 PNG, so a photo can be drawn without any file on disk. */
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

function document(
	bfaType: BfaType,
	signatureMethod: "signed" | "owner_absent",
	photos: { data: Buffer; format: "jpg" | "png" }[] = [],
) {
	const wizardData = sampleData(bfaType);

	return ResultDocument({
		title: resultDocumentTitle({
			bin: "SEED-BIN-200",
			bfaType,
			testDate: "2026-09-24",
		}),
		submission: {
			id: "00000000-0000-4000-8000-000000000001",
			bfaType,
			submittedBinText: null,
			testDate: "2026-09-24",
			testResult: "pass",
			signatureMethod,
			signatureData:
				signatureMethod === "owner_absent" ? OWNER_ABSENT_DISCLAIMER : null,
		},
		wp: { companyName: "Test WB", address: "1 Water St", pwsid: "HI0000001" },
		certifier: {
			fullName: "Elina A.",
			company: "Backflow Co",
			idNumber: "BF-1",
		},
		asset: null,
		customerName: "Kanye West",
		customerEmail: "kanye@west.com",
		wizardData,
		photos,
		testBlock: TestBlockForTypePdf({ bfaType, wizardData }),
	});
}

describe("the results document", () => {
	const types = Object.keys(WIZARD_TEST_SPEC) as BfaType[];

	it.each(types)("renders a PDF for %s", async (bfaType) => {
		const buffer = await renderToBuffer(document(bfaType, "owner_absent"));

		expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
		expect(buffer.length).toBeGreaterThan(2_000);

		// Set PDF_OUT_DIR to keep the files for a look at the layout.
		const out = process.env.PDF_OUT_DIR;
		if (out) {
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, `${bfaType}.pdf`), buffer);
		}
	});
});

describe("photos in the results document", () => {
	it("draws the attached photos into the PDF", async () => {
		const without = await renderToBuffer(document("DC", "owner_absent"));
		const withPhotos = await renderToBuffer(
			document("DC", "owner_absent", [
				{ data: TINY_PNG, format: "png" },
				{ data: TINY_PNG, format: "png" },
			]),
		);

		expect(withPhotos.subarray(0, 5).toString()).toBe("%PDF-");
		expect(withPhotos.length).toBeGreaterThan(without.length);
	});
});

describe("the results document's name", () => {
	it("names the file by BIN, type and test date, not the submission id", () => {
		expect(
			resultDocumentFileName({
				bin: "SEED-BIN-200",
				bfaType: "DC",
				testDate: "2026-09-25",
			}),
		).toBe("Backflow-Test_SEED-BIN-200_DC_2026-09-25.pdf");
	});

	it("keeps a BIN with spaces or slashes safe as a file name", () => {
		expect(
			resultDocumentFileName({
				bin: "12/B 4",
				bfaType: "RPDA-2",
				testDate: "2026-09-25",
			}),
		).toBe("Backflow-Test_12-B-4_RPDA-2_2026-09-25.pdf");
	});

	it("still names a test with no BIN or date", () => {
		expect(
			resultDocumentFileName({ bin: null, bfaType: "PVB", testDate: null }),
		).toBe("Backflow-Test_No-BIN_PVB_undated.pdf");
	});

	it("titles the PDF in words a person reads", () => {
		expect(
			resultDocumentTitle({
				bin: "SEED-BIN-200",
				bfaType: "DC",
				testDate: "2026-09-25",
			}),
		).toBe("Backflow Reporter.io Test Form — SEED-BIN-200 — DC — 09/25/2026");
	});
});
