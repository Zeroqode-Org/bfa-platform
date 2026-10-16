import { db } from "@bfa-platform/db";
import {
	bfaAssets,
	certifiers,
	profiles,
	testSubmissions,
	waterPurveyors,
} from "@bfa-platform/db/schema";
import { renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";

import { isPreviewablePhotoPath } from "../photo-rules";
import { PHOTO_BUCKET } from "../photo-storage";
import { createStorageAdmin } from "../storage-admin";
import {
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
	PHOTO_PATH_KEYS,
} from "../wizard-input";
import { resultDocumentFileName, resultDocumentTitle } from "./document-name";
import { ResultDocument } from "./frame";
import { TestBlockForTypePdf } from "./test-blocks";

/** The two image formats the PDF library can draw, told apart by their first bytes. */
function imageFormat(bytes: Buffer): "jpg" | "png" | null {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";

	return null;
}

/**
 * The test's photos, fetched from the private bucket for embedding. Only
 * JPEG/PNG keys are fetched at all — a HEIC cannot be drawn, so downloading it
 * would only be thrown away. A photo that cannot be fetched, or whose bytes
 * are not what its key says, is left out rather than failing the whole
 * document — the attachment count on the form still records that it was
 * attached.
 */
async function loadPhotos(
	wizardData: Record<string, unknown>,
): Promise<{ data: Buffer; format: "jpg" | "png" }[]> {
	const storage = createStorageAdmin();
	const photos: { data: Buffer; format: "jpg" | "png" }[] = [];

	for (const key of PHOTO_PATH_KEYS) {
		const path = wizardData[key];
		if (typeof path !== "string" || !isPreviewablePhotoPath(path)) continue;

		try {
			const data = await storage.download(PHOTO_BUCKET, path);
			const format = imageFormat(data);

			if (format) photos.push({ data, format });
		} catch {
			// Left out; see above.
		}
	}

	return photos;
}

/**
 * Renders one submitted test's results document (build-plan § 6.5 step 22).
 *
 * Deterministic and cheap enough to regenerate on demand rather than store
 * the rendered bytes — no schema column carries a stored path, so this is
 * the one function anything wanting "the PDF" calls, rather than a cached
 * copy that could drift from the row it was made from.
 */
export async function renderResultPdf(submissionId: string): Promise<{
	buffer: Buffer;
	/** The readable name to store and offer the file under. */
	fileName: string;
	customerEmail: string;
	waterPurveyorId: string;
}> {
	const [row] = await db
		.select({
			id: testSubmissions.id,
			bfaType: testSubmissions.bfaType,
			wizardData: testSubmissions.wizardData,
			submittedBinText: testSubmissions.submittedBinText,
			testDate: testSubmissions.testDate,
			testResult: testSubmissions.testResult,
			signatureMethod: testSubmissions.signatureMethod,
			signatureData: testSubmissions.signatureData,
			waterPurveyorId: testSubmissions.waterPurveyorId,
			bfaAssetId: testSubmissions.bfaAssetId,
			certifierId: testSubmissions.certifierId,
		})
		.from(testSubmissions)
		.where(eq(testSubmissions.id, submissionId))
		.limit(1);

	if (!row) throw new Error(`No submission ${submissionId} to render`);

	const [wp] = await db
		.select({
			companyName: waterPurveyors.companyName,
			address: waterPurveyors.address,
			pwsid: waterPurveyors.pwsid,
		})
		.from(waterPurveyors)
		.where(eq(waterPurveyors.id, row.waterPurveyorId))
		.limit(1);

	const [certifierRow] = await db
		.select({
			fullName: profiles.fullName,
			company: certifiers.company,
			idNumber: certifiers.idNumber,
		})
		.from(certifiers)
		.innerJoin(profiles, eq(profiles.id, certifiers.profileId))
		.where(eq(certifiers.id, row.certifierId))
		.limit(1);

	const asset = row.bfaAssetId
		? ((
				await db
					.select({
						bin: bfaAssets.bin,
						serviceAddress: bfaAssets.serviceAddress,
						make: bfaAssets.make,
						model: bfaAssets.model,
						serialNumber: bfaAssets.serialNumber,
						size: bfaAssets.size,
						assemblyLocation: bfaAssets.assemblyLocation,
					})
					.from(bfaAssets)
					.where(eq(bfaAssets.id, row.bfaAssetId))
					.limit(1)
			)[0] ?? null)
		: null;

	if (!wp || !certifierRow) {
		throw new Error(
			`Could not resolve the WP or certifier for submission ${submissionId}`,
		);
	}

	const wizardData = (row.wizardData ?? {}) as Record<string, unknown>;
	const customerName = String(wizardData[CUSTOMER_NAME_KEY] ?? "");
	const customerEmail = String(wizardData[CUSTOMER_EMAIL_KEY] ?? "");

	const photos = await loadPhotos(wizardData);
	const bin = asset?.bin ?? row.submittedBinText ?? null;
	const nameParts = { bin, bfaType: row.bfaType, testDate: row.testDate };

	const buffer = await renderToBuffer(
		ResultDocument({
			title: resultDocumentTitle(nameParts),
			submission: {
				id: row.id,
				bfaType: row.bfaType,
				submittedBinText: row.submittedBinText,
				testDate: row.testDate,
				testResult: row.testResult,
				signatureMethod: row.signatureMethod,
				signatureData: row.signatureData,
			},
			wp,
			certifier: certifierRow,
			asset,
			customerName,
			customerEmail,
			wizardData,
			photos,
			testBlock: TestBlockForTypePdf({ bfaType: row.bfaType, wizardData }),
		}),
	);

	return {
		buffer,
		fileName: resultDocumentFileName(nameParts),
		customerEmail,
		waterPurveyorId: row.waterPurveyorId,
	};
}
