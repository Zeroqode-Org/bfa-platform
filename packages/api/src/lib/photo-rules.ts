/**
 * The closing-block photo contract (build-plan § 6.5 step 18), shared by the
 * browser's pre-upload check, `getPhotoUploadUrl`'s input, and every place a
 * stored photo path is trusted again (`cleanWizardData`, `submitTest`,
 * `getPhotoUrls`). One definition, so the client cannot be looser than the
 * server or the path check looser than the key the server mints.
 *
 * Pure logic, no DB import — the web bundle imports it for the file picker.
 *
 * What this is not: a check of the bytes. Extension and MIME type are the
 * client's claim about a file; they pick the server-generated object key and
 * the content type Storage records, and the `test-photos` bucket's own MIME
 * and size policy (`apps/web/scripts/supabase-setup.mjs`) enforces the same
 * claim a second time — but nothing here proves a `.jpg` is a JPEG. Access
 * stays safe regardless: private bucket, server-minted keys, short-lived
 * signed links, and the ownership checks in `certifier-wizard.ts`.
 */

/** Photos a test may carry at most. */
export const MAX_PHOTOS = 2;

/**
 * 25 MB (25 × 1024² bytes) — the largest single photo accepted. Every phone
 * camera's photo fits with room to spare (HEIC 1–5 MB, high-resolution JPEG
 * up to ~25 MB), it stays under the Free plan's 50 MB global Storage limit,
 * and it is small enough for the current single-request upload.
 */
export const MAX_PHOTO_BYTES = 25 * 1024 ** 2;

/** `MAX_PHOTO_BYTES` as people read it, for the hint and the error. */
export const MAX_PHOTO_SIZE_LABEL = "25 MB";

/** Each accepted format's canonical extension and the MIME type it is stored under. */
export const PHOTO_FORMATS = {
	jpg: "image/jpeg",
	png: "image/png",
	heic: "image/heic",
} as const;

export type PhotoExtension = keyof typeof PHOTO_FORMATS;
export type PhotoContentType = (typeof PHOTO_FORMATS)[PhotoExtension];

export const PHOTO_EXTENSIONS = [
	"jpg",
	"png",
	"heic",
] as const satisfies readonly PhotoExtension[];
export const PHOTO_CONTENT_TYPES = [
	"image/jpeg",
	"image/png",
	"image/heic",
] as const satisfies readonly PhotoContentType[];

/** File-name extensions a picked file may carry, mapped to the canonical one. */
const EXTENSION_ALIASES: Record<string, PhotoExtension> = {
	jpg: "jpg",
	jpeg: "jpg",
	png: "png",
	heic: "heic",
};

/** The file input's `accept`: the extensions and the MIME types, since pickers honour one or the other. */
export const PHOTO_ACCEPT = [
	".jpg",
	".jpeg",
	".png",
	".heic",
	...PHOTO_CONTENT_TYPES,
].join(",");

/**
 * Browser-reported types that agree with each canonical extension. Only the
 * canonical type is ever sent on or stored; this is just what is tolerated as
 * `File.type`. Some Android galleries and desktop type maps report a `.heic`
 * photo as `image/heif` — it is the same file, so it is not a mismatch. A
 * `.heif` file is still refused: HEIF is not an accepted format.
 */
const BROWSER_TYPES: Record<PhotoExtension, readonly string[]> = {
	jpg: ["image/jpeg"],
	png: ["image/png"],
	heic: ["image/heic", "image/heif"],
};

export type PhotoRejection = "empty" | "format" | "size";

export const PHOTO_REJECTION_MESSAGES: Record<PhotoRejection, string> = {
	empty: "That file is empty.",
	format: "Supported formats are HEIC, PNG and JPG/JPEG.",
	size: `Each photo must be ${MAX_PHOTO_SIZE_LABEL} or smaller.`,
};

/** The canonical extension of a file name (`IMG_1.JPEG` → `jpg`), or null when it is not one of the accepted formats. */
export function canonicalPhotoExtension(
	fileName: string,
): PhotoExtension | null {
	const dot = fileName.lastIndexOf(".");
	if (dot < 0) return null;

	return EXTENSION_ALIASES[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

export type PhotoCheck =
	| {
			ok: true;
			extension: PhotoExtension;
			contentType: PhotoContentType;
			size: number;
	  }
	| { ok: false; reason: PhotoRejection };

/**
 * Whether a picked file may be uploaded, and if so the normalised metadata to
 * ask for an upload URL with. The file name decides the format; `File.type`
 * is a hint only — browsers leave it empty for HEIC often enough that
 * requiring it would refuse real phone photos — so an empty type is accepted,
 * and so is one of `BROWSER_TYPES`, but a type that disagrees with the
 * extension is not.
 */
export function checkPhotoFile(file: {
	name: string;
	type: string;
	size: number;
}): PhotoCheck {
	if (!Number.isSafeInteger(file.size) || file.size <= 0) {
		return { ok: false, reason: "empty" };
	}

	const extension = canonicalPhotoExtension(file.name);
	if (!extension) return { ok: false, reason: "format" };

	const contentType = PHOTO_FORMATS[extension];
	if (
		file.type !== "" &&
		!BROWSER_TYPES[extension].includes(file.type.toLowerCase())
	) {
		return { ok: false, reason: "format" };
	}

	if (file.size > MAX_PHOTO_BYTES) return { ok: false, reason: "size" };

	return { ok: true, extension, contentType, size: file.size };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PHOTO_PATH_PATTERN = new RegExp(
	`^(${UUID})/${UUID}\\.(${PHOTO_EXTENSIONS.join("|")})$`,
);

/**
 * A stored photo path's parts, when it has exactly the shape the server mints:
 * `<submission uuid>/<uuid>.<jpg|png|heic>`, lower case. Anything else —
 * traversal, another extension, a user-chosen name — is null.
 */
export function parsePhotoPath(
	path: unknown,
): { submissionId: string; extension: PhotoExtension } | null {
	if (typeof path !== "string") return null;

	const match = PHOTO_PATH_PATTERN.exec(path);
	if (!match?.[1] || !match[2]) return null;

	return {
		submissionId: match[1],
		extension: match[2] as PhotoExtension,
	};
}

/** A photo path is the caller's own only when it parses and sits in that submission's own folder — nothing else is ever signed, embedded or stored. */
export function isOwnPhotoPath(submissionId: string, path: unknown): boolean {
	return parsePhotoPath(path)?.submissionId === submissionId.toLowerCase();
}

/** How many leading bytes `sniffPhotoFormat` needs to see. */
export const PHOTO_SNIFF_BYTES = 64;

/** ISO-BMFF brands that mean a HEVC-coded HEIF image, i.e. a HEIC. */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
/** Generic HEIF brands; a HEIC only when a HEIC brand is also listed (AVIF uses these too). */
const HEIF_BRANDS = new Set(["mif1", "msf1"]);

function ascii(bytes: Uint8Array, from: number, to: number): string {
	return String.fromCharCode(...bytes.subarray(from, to));
}

/**
 * What a file actually is, from its first bytes: JPEG, PNG or HEIC, or null
 * for anything else. The name and `File.type` are claims; this is the one
 * check that looks at the content. Used by the wizard to upload a photo in
 * its real format (a JPEG named `.heic` goes up as a JPEG) and by the results
 * PDF to decide what it can draw.
 */
export function sniffPhotoFormat(bytes: Uint8Array): PhotoExtension | null {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (
		bytes.length >= 8 &&
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
			(byte, index) => bytes[index] === byte,
		)
	) {
		return "png";
	}

	// HEIF: a `ftyp` box first — 4-byte size, "ftyp", major brand, minor
	// version, then the compatible brands up to the box's size.
	if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return null;

	const major = ascii(bytes, 8, 12);
	if (HEIC_BRANDS.has(major)) return "heic";
	if (!HEIF_BRANDS.has(major)) return null;

	const boxSize =
		((bytes[0] ?? 0) << 24) |
		((bytes[1] ?? 0) << 16) |
		((bytes[2] ?? 0) << 8) |
		(bytes[3] ?? 0);
	const end = Math.min(boxSize, bytes.length);
	for (let offset = 16; offset + 4 <= end; offset += 4) {
		if (HEIC_BRANDS.has(ascii(bytes, offset, offset + 4))) return "heic";
	}

	return null;
}
