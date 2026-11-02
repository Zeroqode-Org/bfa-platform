import { describe, expect, it } from "vitest";

import {
	canonicalPhotoExtension,
	checkPhotoFile,
	MAX_PHOTO_BYTES,
	PHOTO_ACCEPT,
	sniffPhotoFormat,
} from "./photo-rules";
import {
	ASSEMBLY_FIELD_KEYS,
	allowedWizardKeys,
	carryOverAnswers,
	cleanWizardData,
	deriveTestResult,
	getPhotoUploadUrlInput,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	isOwnPhotoPath,
	missingWizardFields,
	OWNER_ABSENT_DISCLAIMER,
	parseSize,
	photoUrlsInput,
	recordOverride,
	saveDraftStepInput,
	submitTestInput,
	valveYesWithReading,
	WATER_METER_START_KEY,
	WIZARD_TEST_SPEC,
	type WizardQuestion,
	wizardQuestionsFor,
	wizardRequiredFieldsFor,
} from "./wizard-input";

/**
 * The wizard's own input rules on their own — no database, no tRPC caller.
 * Mirrors `submission-input.test.ts`'s own reasoning: these are boundary
 * rules a client cannot be trusted to have applied, so they are worth
 * asserting independent of anything that would need a Postgres.
 */

describe("WIZARD_TEST_SPEC — the client's sheet, type by type", () => {
	const headings = (bfaType: keyof typeof WIZARD_TEST_SPEC) =>
		WIZARD_TEST_SPEC[bfaType].sections.map((section) => section.title);

	it("gives RPDA and RPDA-2 an RP main test, then a bypass", () => {
		expect(headings("RPDA")).toEqual([
			"RP TEST 1",
			"DA TEST 2 — BYPASS ASSEMBLY",
		]);
		expect(headings("RPDA-2")).toEqual([
			"RP TEST 1",
			"DA TEST 2 — BYPASS ASSEMBLY",
		]);
	});

	it("puts the bypass first for DCDA and DCDA-2", () => {
		expect(headings("DCDA")).toEqual([
			"DA TEST 1 — BYPASS ASSEMBLY",
			"DC TEST 2 — MAIN ASSEMBLY",
		]);
		expect(headings("DCDA-2")).toEqual([
			"DA TEST 1 — BYPASS ASSEMBLY",
			"DC TEST 2 — MAIN ASSEMBLY",
		]);
	});

	it("gives the RPDA bypass a relief valve and two check valves, the -2 bypass one", () => {
		expect(
			wizardQuestionsFor("RPDA").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(3);
		expect(
			wizardQuestionsFor("RPDA-2").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(1);
		expect(
			wizardQuestionsFor("DCDA").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(2);
		expect(
			wizardQuestionsFor("DCDA-2").filter((q) => q.key.startsWith("bypass.")),
		).toHaveLength(1);
	});

	it("asks for the relief valve only in the RP family", () => {
		for (const type of ["RP", "RPDA", "RPDA-2"] as const) {
			expect(
				wizardRequiredFieldsFor(type).some((key) =>
					key.endsWith("reliefValveOpened"),
				),
			).toBe(true);
		}
		for (const type of ["DC", "DCDA", "DCDA-2", "PVB", "SVB"] as const) {
			expect(
				wizardRequiredFieldsFor(type).some((key) =>
					key.endsWith("reliefValveOpened"),
				),
			).toBe(false);
		}
	});

	it("takes ADP only for RP, RPDA and RPDA-2", () => {
		expect(
			(
				Object.keys(WIZARD_TEST_SPEC) as (keyof typeof WIZARD_TEST_SPEC)[]
			).filter((type) => WIZARD_TEST_SPEC[type].hasAdp),
		).toEqual(["RP", "RPDA", "RPDA-2"]);
	});

	it("takes water meter readings only for the four detector types", () => {
		expect(
			(
				Object.keys(WIZARD_TEST_SPEC) as (keyof typeof WIZARD_TEST_SPEC)[]
			).filter((type) => WIZARD_TEST_SPEC[type].hasMeter),
		).toEqual(["RPDA", "RPDA-2", "DCDA", "DCDA-2"]);
	});

	it("asks a PVB its air inlet first: opened, fully opened, then the check valve", () => {
		expect(wizardQuestionsFor("PVB").map((q) => q.key)).toEqual([
			"airInletValveOpened",
			"airInletValveFullyOpened",
			"checkValveShutTight",
		]);
	});

	it("asks an SVB its check valve first, then the air inlet — the sheet's own order", () => {
		expect(wizardQuestionsFor("SVB").map((q) => q.key)).toEqual([
			"checkValveShutTight",
			"airInletValveOpened",
			"airInletValveFullyOpened",
		]);
	});

	it("words every valve answer in the client's terms", () => {
		const byKey = (type: keyof typeof WIZARD_TEST_SPEC) =>
			Object.fromEntries(
				wizardQuestionsFor(type).map((q) => [q.key, [q.label, q.answers]]),
			);

		expect(byKey("RP")).toMatchObject({
			reliefValveOpened: [
				"Differential Relief Valve",
				{ yes: "Opened at", no: "Did not open" },
			],
			checkValve2ShutTight: ["Check Valve 2", { yes: "Tight", no: "Leak" }],
		});
		expect(byKey("RPDA")["bypass.reliefValveOpened"]?.[0]).toBe(
			"Bypass Differential Relief Valve",
		);
		expect(byKey("DCDA")["bypass.checkValve1ShutTight"]?.[0]).toBe(
			"Bypass Check Valve 1",
		);
		expect(byKey("DCDA-2")["bypass.checkValve1ShutTight"]?.[0]).toBe(
			"Bypass Check Valve",
		);
		expect(byKey("PVB")).toMatchObject({
			airInletValveOpened: [
				"Air Inlet",
				{ yes: "Opened at", no: "Did not open" },
			],
			airInletValveFullyOpened: [
				"Air Inlet (full opening)",
				{ yes: "Fully opened", no: "Did not fully open" },
			],
			checkValveShutTight: ["Check Valve", { yes: "Tight", no: "Leak" }],
		});
	});

	it("asks one Initial Test and the isolates question for every type", () => {
		for (const type of Object.keys(
			WIZARD_TEST_SPEC,
		) as (keyof typeof WIZARD_TEST_SPEC)[]) {
			const keys = wizardRequiredFieldsFor(type);
			expect(keys.filter((key) => key.endsWith("initialTestResult"))).toEqual([
				INITIAL_TEST_KEY,
			]);
			expect(keys).toContain(ISOLATES_PROPERTY_KEY);
		}
	});
});

describe("missingWizardFields", () => {
	const complete = (type: keyof typeof WIZARD_TEST_SPEC) => ({
		...Object.fromEntries(
			Object.values(ASSEMBLY_FIELD_KEYS).map((key) => [key, "x"]),
		),
		...Object.fromEntries(
			wizardRequiredFieldsFor(type).map((key) => [
				key,
				key === INITIAL_TEST_KEY ? "pass" : false,
			]),
		),
	});

	it("reports every required key missing from an empty draft", () => {
		expect(missingWizardFields("RP", {})).toEqual([
			...Object.values(ASSEMBLY_FIELD_KEYS),
			...wizardRequiredFieldsFor("RP"),
		]);
	});

	it("requires all six assembly details, prefilled or typed", () => {
		const { [ASSEMBLY_FIELD_KEYS.make]: _make, ...withoutMake } =
			complete("DC");
		expect(missingWizardFields("DC", withoutMake)).toEqual([
			ASSEMBLY_FIELD_KEYS.make,
		]);
	});

	it("treats null and a blank string the same as absent", () => {
		expect(missingWizardFields("PVB", { checkValveShutTight: null })).toContain(
			"checkValveShutTight",
		);
		expect(missingWizardFields("PVB", { checkValveShutTight: "" })).toContain(
			"checkValveShutTight",
		);
	});

	it("accepts a No answer — false is an answer, not a gap", () => {
		expect(missingWizardFields("DC", complete("DC"))).toEqual([]);
	});

	it("requires a value only when the question was answered Yes", () => {
		const yes = { ...complete("DC"), checkValve1ShutTight: true };
		expect(missingWizardFields("DC", yes)).toEqual(["checkValve1Value"]);
		expect(
			missingWizardFields("DC", { ...yes, checkValve1Value: "3.2" }),
		).toEqual([]);
	});

	it("insists on exactly pass or fail for the Initial Test", () => {
		expect(
			missingWizardFields("DC", {
				...complete("DC"),
				[INITIAL_TEST_KEY]: "maybe",
			}),
		).toEqual([INITIAL_TEST_KEY]);
	});

	it("requires the meter pair for a detector type and not for a single line", () => {
		expect(missingWizardFields("DCDA", {})).toContain(WATER_METER_START_KEY);
		expect(missingWizardFields("DC", {})).not.toContain(WATER_METER_START_KEY);
	});
});

describe("deriveTestResult", () => {
	it("is the Initial Test answer", () => {
		expect(deriveTestResult({ [INITIAL_TEST_KEY]: "pass" })).toBe("pass");
		expect(deriveTestResult({ [INITIAL_TEST_KEY]: "fail" })).toBe("fail");
	});
});

describe("recordOverride", () => {
	it("adds a new key once", () => {
		expect(recordOverride([], "customerEmail")).toEqual(["customerEmail"]);
	});

	it("does not duplicate an already-recorded key", () => {
		expect(recordOverride(["customerEmail"], "customerEmail")).toEqual([
			"customerEmail",
		]);
	});
});

describe("saveDraftStepInput", () => {
	it("accepts a half-filled step with no required-field checking at all", () => {
		const result = saveDraftStepInput.safeParse({
			waterPurveyorId: "8400a5b0-6b0a-4a6f-8b1a-000000000001",
			bfaType: "RP",
			currentStep: 1,
			wizardData: {},
		});
		expect(result.success).toBe(true);
	});
});

describe("submitTestInput", () => {
	const base = {
		id: "8400a5b0-6b0a-4a6f-8b1a-000000000002",
		waterPurveyorId: "8400a5b0-6b0a-4a6f-8b1a-000000000001",
		bfaType: "RP" as const,
		wizardData: {},
		customerName: "Jane Doe",
		customerEmail: "jane@example.com",
		testDate: "2026-01-01",
		signatureMethod: "signed" as const,
		signatureData: "data:image/png;base64,abc",
		photoPaths: [],
	};

	it("accepts a complete submission", () => {
		expect(submitTestInput.safeParse(base).success).toBe(true);
	});

	it("refuses an invalid customer email", () => {
		expect(
			submitTestInput.safeParse({ ...base, customerEmail: "not-an-email" })
				.success,
		).toBe(false);
	});

	it("carries no client-supplied test result — the server derives it", () => {
		expect("testResult" in submitTestInput.shape).toBe(false);
	});
});

describe("OWNER_ABSENT_DISCLAIMER", () => {
	it("matches the exact mandatory wording from the build plan", () => {
		expect(OWNER_ABSENT_DISCLAIMER).toBe(
			"Owner was not present - I certify under penalty of law and regulatory compliance guidelines that the assembly test values recorded above are true and accurate. The property manager was not present to sign the physical digital screen at the time of service.",
		);
	});
});

describe("assembly size, a number", () => {
	it("reads a size as a plain decimal from however it was written", () => {
		expect(parseSize("1 inch")).toBe("1");
		expect(parseSize("2 in")).toBe("2");
		expect(parseSize("3/4 inch")).toBe("0.75");
		expect(parseSize("1 1/2")).toBe("1.5");
		expect(parseSize("0.75")).toBe("0.75");
	});

	it("keeps text with no number in it rather than losing it", () => {
		expect(parseSize("large")).toBe("large");
		expect(parseSize(null)).toBe("");
	});
});

describe("photo file rules", () => {
	const photo = (name: string, type: string, size = 1024) => ({
		name,
		type,
		size,
	});

	it("accepts each allowlisted extension/MIME pair and normalises it", () => {
		expect(checkPhotoFile(photo("a.jpg", "image/jpeg"))).toEqual({
			ok: true,
			extension: "jpg",
			contentType: "image/jpeg",
			size: 1024,
		});
		expect(checkPhotoFile(photo("a.jpeg", "image/jpeg"))).toMatchObject({
			ok: true,
			extension: "jpg",
			contentType: "image/jpeg",
		});
		expect(checkPhotoFile(photo("a.png", "image/png"))).toMatchObject({
			ok: true,
			extension: "png",
			contentType: "image/png",
		});
		expect(checkPhotoFile(photo("a.heic", "image/heic"))).toMatchObject({
			ok: true,
			extension: "heic",
			contentType: "image/heic",
		});
	});

	it("reads the extension case-insensitively, `.jpeg` becoming `jpg`", () => {
		expect(canonicalPhotoExtension("IMG_0001.JPEG")).toBe("jpg");
		expect(canonicalPhotoExtension("IMG_0001.HEIC")).toBe("heic");
		expect(canonicalPhotoExtension("scan.Png")).toBe("png");
		expect(checkPhotoFile(photo("IMG_1.HEIC", ""))).toMatchObject({
			ok: true,
			extension: "heic",
			contentType: "image/heic",
		});
	});

	it("accepts an empty browser type but not a mismatched one", () => {
		expect(checkPhotoFile(photo("a.heic", "")).ok).toBe(true);
		// Some galleries report a `.heic` as `image/heif`; it is still a HEIC,
		// and still sent on as the canonical `image/heic`.
		expect(checkPhotoFile(photo("a.heic", "image/heif"))).toMatchObject({
			ok: true,
			extension: "heic",
			contentType: "image/heic",
		});
		expect(checkPhotoFile(photo("a.jpg", "image/heif"))).toEqual({
			ok: false,
			reason: "format",
		});
		expect(checkPhotoFile(photo("a.jpg", "image/png"))).toEqual({
			ok: false,
			reason: "format",
		});
		expect(checkPhotoFile(photo("a.png", "image/heic"))).toEqual({
			ok: false,
			reason: "format",
		});
	});

	it("refuses other formats, PDF included, and names without an extension", () => {
		for (const [name, type] of [
			["a.pdf", "application/pdf"],
			["a.pdf", ""],
			["a.jpg", "application/pdf"],
			["a.heif", "image/heif"],
			["a.webp", "image/webp"],
			["a.gif", "image/gif"],
			["a.jpg.exe", ""],
			["jpg", "image/jpeg"],
			["a.", "image/jpeg"],
		] as const) {
			expect(checkPhotoFile(photo(name, type))).toEqual({
				ok: false,
				reason: "format",
			});
		}
		expect(PHOTO_ACCEPT).not.toMatch(/pdf|heif|webp|gif|image\/\*/);
	});

	it("accepts exactly 25 MB and refuses one byte more, or an empty file", () => {
		expect(MAX_PHOTO_BYTES).toBe(26_214_400);
		expect(
			checkPhotoFile(photo("a.jpg", "image/jpeg", MAX_PHOTO_BYTES)).ok,
		).toBe(true);
		expect(
			checkPhotoFile(photo("a.jpg", "image/jpeg", MAX_PHOTO_BYTES + 1)),
		).toEqual({ ok: false, reason: "size" });
		expect(checkPhotoFile(photo("a.jpg", "image/jpeg", 0))).toEqual({
			ok: false,
			reason: "empty",
		});
	});
});

describe("sniffPhotoFormat", () => {
	const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
	const ftyp = (major: string, ...compatible: string[]) =>
		new Uint8Array([
			0,
			0,
			0,
			16 + compatible.length * 4,
			...ascii("ftyp"),
			...ascii(major),
			0,
			0,
			0,
			0,
			...compatible.flatMap(ascii),
		]);

	it("recognises JPEG, PNG and HEIC by their first bytes", () => {
		expect(sniffPhotoFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).toBe(
			"jpg",
		);
		expect(
			sniffPhotoFormat(
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			),
		).toBe("png");
		expect(sniffPhotoFormat(ftyp("heic", "mif1", "heic"))).toBe("heic");
		expect(sniffPhotoFormat(ftyp("heix"))).toBe("heic");
		// A generic HEIF brand counts only with a HEIC brand alongside it.
		expect(sniffPhotoFormat(ftyp("mif1", "miaf", "heic"))).toBe("heic");
	});

	it("refuses everything else: AVIF, generic HEIF, PDF, WebP, truncated", () => {
		for (const bytes of [
			ftyp("avif", "mif1", "miaf"),
			ftyp("mif1", "avif"),
			ftyp("mif1"),
			new Uint8Array(ascii("%PDF-1.4 the rest of it")),
			new Uint8Array(ascii("RIFF    WEBPVP8 ")),
			new Uint8Array([0xff, 0xd8]),
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			new Uint8Array([]),
		]) {
			expect(sniffPhotoFormat(bytes)).toBeNull();
		}
	});
});

describe("getPhotoUploadUrlInput", () => {
	const base = {
		id: "11111111-1111-4111-8111-111111111111",
		waterPurveyorId: "22222222-2222-4222-8222-222222222222",
	};

	it("takes only a normalised, allowlisted pair within the limit", () => {
		expect(
			getPhotoUploadUrlInput.safeParse({
				...base,
				extension: "heic",
				contentType: "image/heic",
				size: MAX_PHOTO_BYTES,
			}).success,
		).toBe(true);

		for (const claim of [
			{ extension: "jpeg", contentType: "image/jpeg", size: 1 },
			{ extension: "JPG", contentType: "image/jpeg", size: 1 },
			{ extension: "pdf", contentType: "application/pdf", size: 1 },
			{ extension: "jpg", contentType: "image/png", size: 1 },
			{ extension: "png", contentType: "image/png", size: 0 },
			{
				extension: "png",
				contentType: "image/png",
				size: MAX_PHOTO_BYTES + 1,
			},
			{ extension: "png", contentType: "image/png", size: 1.5 },
			{ extension: "png", contentType: "image/png" },
		]) {
			expect(
				getPhotoUploadUrlInput.safeParse({ ...base, ...claim }).success,
			).toBe(false);
		}
	});

	it("holds the photos-to-keep list to two entries", () => {
		const claim = { extension: "png", contentType: "image/png", size: 10 };

		expect(getPhotoUploadUrlInput.parse({ ...base, ...claim }).keep).toEqual(
			[],
		);
		expect(
			getPhotoUploadUrlInput.safeParse({
				...base,
				...claim,
				keep: ["a", "b", "c"],
			}).success,
		).toBe(false);
	});

	it("carries no client path or file name through", () => {
		const parsed = getPhotoUploadUrlInput.parse({
			...base,
			extension: "png",
			contentType: "image/png",
			size: 10,
			path: "../other/file.png",
			name: "evil.png",
		});

		expect(parsed).not.toHaveProperty("path");
		expect(parsed).not.toHaveProperty("name");
	});

	it("caps the photo paths a signing request may carry at two", () => {
		expect(
			photoUrlsInput.safeParse({ ...base, paths: ["a", "b", "c"] }).success,
		).toBe(false);
	});
});

describe("photo paths and wizard-data cleaning", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const other = "22222222-2222-4222-8222-222222222222";
	const uuid = "33333333-3333-4333-8333-333333333333";
	const file = `${uuid}.jpg`;

	it("accepts a server-shaped key of each canonical extension, in the submission's own folder only", () => {
		for (const extension of ["jpg", "png", "heic"]) {
			expect(isOwnPhotoPath(id, `${id}/${uuid}.${extension}`)).toBe(true);
		}
		const lettered = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		expect(isOwnPhotoPath(lettered.toUpperCase(), `${lettered}/${file}`)).toBe(
			true,
		);
		expect(isOwnPhotoPath(id, `${other}/${file}`)).toBe(false);
		expect(isOwnPhotoPath(id, null)).toBe(false);
	});

	it("refuses traversal, other extensions and anything not server-minted", () => {
		for (const path of [
			`${id}/../${other}/${file}`,
			`${id}/./${file}`,
			`${id}//${file}`,
			`/${id}/${file}`,
			`${id}/${other}/${file}`,
			`${id}/notauuid.jpg`,
			`${id}/${uuid}.jpeg`,
			`${id}/${uuid}.JPG`,
			`${id}/${uuid}.pdf`,
			`${id}/${uuid}.heif`,
			`${id}/${uuid}.jpg.pdf`,
			`${id}/${uuid}`,
			`${id}/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.jpg`,
			`${id}/------------------------------------.jpg`,
			`${id}/${file}\n`,
		]) {
			expect(isOwnPhotoPath(id, path)).toBe(false);
		}
	});

	it("drops keys of another type, foreign photos and the disclaimer", () => {
		const rp = allowedWizardKeys("RP");
		const foreign = [...allowedWizardKeys("DC")].find((key) => !rp.has(key));
		const cleaned = cleanWizardData(
			"RP",
			{
				comments: "ok",
				photo1Path: `${other}/${file}`,
				photo2Path: `${id}/${file}`,
				signOffDisclaimer: "forged",
				...(foreign ? { [foreign]: "x" } : {}),
				bogus: "y",
			},
			id,
		);

		expect(cleaned).toEqual({ comments: "ok", photo2Path: `${id}/${file}` });
	});

	it("keeps a PNG or HEIC photo of its own but drops an unlisted extension", () => {
		const cleaned = cleanWizardData(
			"RP",
			{
				photo1Path: `${id}/${uuid}.heic`,
				photo2Path: `${id}/${uuid}.pdf`,
			},
			id,
		);

		expect(cleaned).toEqual({ photo1Path: `${id}/${uuid}.heic` });
		expect(
			cleanWizardData("RP", { photo1Path: `${id}/${uuid}.png` }, undefined),
		).toEqual({});
	});

	it("submitTestInput holds at most two photo paths", () => {
		const paths = [
			`${id}/${uuid}.jpg`,
			`${id}/${uuid}.png`,
			`${id}/${uuid}.heic`,
		];

		expect(
			submitTestInput.shape.photoPaths.safeParse(paths.slice(0, 2)).success,
		).toBe(true);
		expect(submitTestInput.shape.photoPaths.safeParse(paths).success).toBe(
			false,
		);
	});

	it("carries readings over but not a previous visit's photos or customer", () => {
		const carried = carryOverAnswers("RP", {
			initialTestResult: "pass",
			photo1Path: `${id}/${file}`,
			customerName: "Jane",
			comments: "old",
		});

		expect(carried).toEqual({ initialTestResult: "pass" });
	});
});

describe("valve answer wording", () => {
	const [relief, , checkValve1] = wizardQuestionsFor("RP");
	const pvbCheck = wizardQuestionsFor("PVB")[2];

	it("reads a reading into the answer as one phrase", () => {
		expect(valveYesWithReading(relief as WizardQuestion, "2.0")).toBe(
			"Opened at 2.0 PSID",
		);
		expect(valveYesWithReading(checkValve1 as WizardQuestion, "4.5")).toBe(
			"Tight — 4.5 PSID",
		);
		expect(valveYesWithReading(pvbCheck as WizardQuestion, "1.2")).toBe(
			"Tight — Check held at 1.2 PSID",
		);
	});

	it("says a missing reading is missing, and leaves a part without one bare", () => {
		const [, checkValve2] = wizardQuestionsFor("RP");

		expect(valveYesWithReading(relief as WizardQuestion, null)).toBe(
			"Opened at — no reading",
		);
		expect(valveYesWithReading(checkValve2 as WizardQuestion, null)).toBe(
			"Tight",
		);
	});

	it("labels every reading input as the WP's document lists it", () => {
		expect(pvbCheck?.valueLabel).toBe("Check Valve reading");
		expect(relief?.valueLabel).toBe("Differential Relief Valve opened at");
	});
});
