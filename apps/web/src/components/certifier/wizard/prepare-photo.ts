import {
	checkPhotoFile,
	MAX_PHOTO_BYTES,
	PHOTO_FORMATS,
	PHOTO_SNIFF_BYTES,
	type PhotoContentType,
	type PhotoExtension,
	type PhotoRejection,
	sniffPhotoFormat,
} from "@bfa-platform/api/lib/photo-rules";

/**
 * Turns a picked file into what is actually uploaded.
 *
 * 1. `checkPhotoFile` — name, browser type and size, the same rules the server
 *    holds the request to.
 * 2. The first bytes decide the real format. A file whose content is not a
 *    JPEG, PNG or HEIC is refused, whatever its name; one whose name and
 *    content disagree (a JPEG called `.heic`) is uploaded as what it is.
 * 3. A real HEIC is converted to JPEG here, so it previews in every browser
 *    and is drawn on the results PDF. This uses the browser's own HEIC
 *    decoder — Safari (iPhone, iPad, Mac) has one, which is where HEIC photos
 *    come from — with no extra library. Where the browser cannot decode it
 *    (Chrome on Android or Windows), the HEIC is uploaded unchanged: still
 *    attached, shown as a tile, and left out of the PDF.
 */

/**
 * Longest side of a converted photo. iOS Safari refuses canvases above
 * 16.7 million pixels, and a 24 MP iPhone photo is over that, so a converted
 * photo is scaled down to fit; 4000 px keeps it sharp for the document.
 */
export const MAX_CONVERTED_SIDE = 4000;

/** JPEG quality of a converted HEIC. */
const CONVERTED_QUALITY = 0.9;

export type PreparedPhoto =
	| {
			ok: true;
			body: Blob;
			extension: PhotoExtension;
			contentType: PhotoContentType;
			size: number;
			/** True when a HEIC was re-encoded as JPEG. */
			converted: boolean;
	  }
	| { ok: false; reason: PhotoRejection };

function prepared(
	body: Blob,
	extension: PhotoExtension,
	converted: boolean,
): PreparedPhoto {
	const contentType = PHOTO_FORMATS[extension];

	return {
		ok: true,
		// Typed with the canonical MIME: for a Blob body supabase-js sends the
		// Blob's own type and ignores a `contentType` option. A slice is a view
		// of the file, not a copy.
		body: body.slice(0, body.size, contentType),
		extension,
		contentType,
		size: body.size,
		converted,
	};
}

/** The HEIC re-encoded as JPEG, or null when this browser cannot decode it. */
async function heicToJpeg(file: Blob): Promise<Blob | null> {
	if (typeof createImageBitmap !== "function") return null;

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}

	try {
		const scale = Math.min(
			1,
			MAX_CONVERTED_SIDE / Math.max(bitmap.width, bitmap.height),
		);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));

		const context = canvas.getContext("2d");
		if (!context) return null;
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

		return await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", CONVERTED_QUALITY),
		);
	} finally {
		bitmap.close();
	}
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
	const check = checkPhotoFile(file);
	if (!check.ok) return check;

	const head = new Uint8Array(
		await file.slice(0, PHOTO_SNIFF_BYTES).arrayBuffer(),
	);
	const actual = sniffPhotoFormat(head);
	if (!actual) return { ok: false, reason: "format" };

	if (actual !== "heic") return prepared(file, actual, false);

	const jpeg = await heicToJpeg(file);
	if (!jpeg || jpeg.size === 0) return prepared(file, "heic", false);
	if (jpeg.size > MAX_PHOTO_BYTES) return { ok: false, reason: "size" };

	return prepared(jpeg, "jpg", true);
}
