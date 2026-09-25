import { createStorageAdmin } from "../storage-admin";
import { renderResultPdf } from "./render";

/** How long a signed link to a result document stays valid. */
export const RESULT_DOCUMENT_URL_TTL_SECONDS = 60 * 10;

/**
 * Stores one test's result PDF in the private `result-documents` bucket and
 * returns a short-lived signed link to it.
 *
 * The document is rendered from the row as it is *now*, not read back from an
 * earlier upload: a purveyor may have corrected the test since it was filed,
 * and the file behind the link should show what the record says today. Pass
 * `rendered` when the caller has just rendered it, to avoid rendering twice.
 */
export async function publishResultPdf(
	submissionId: string,
	options: {
		rendered?: { buffer: Buffer; fileName: string };
		ttlSeconds?: number;
	} = {},
): Promise<string> {
	const { buffer, fileName } =
		options.rendered ?? (await renderResultPdf(submissionId));
	const storage = createStorageAdmin();
	// The readable name is the last segment of the link, which is what a viewer
	// shows in its tab and a browser proposes when saving; the submission id
	// folder keeps two tests with the same BIN and date apart.
	const path = `${submissionId}/${fileName}`;

	await storage.upload("result-documents", path, buffer, "application/pdf");

	return storage.createSignedDownloadUrl(
		"result-documents",
		path,
		options.ttlSeconds ?? RESULT_DOCUMENT_URL_TTL_SECONDS,
	);
}
