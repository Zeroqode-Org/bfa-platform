import {
	MAX_PHOTO_BYTES,
	PHOTO_CONTENT_TYPES,
} from "@bfa-platform/api/lib/photo-rules";
import { describe, expect, it } from "vitest";

import { BUCKETS } from "./storage-buckets.mjs";

/**
 * The photo contract exists twice: in `photo-rules.ts`, which the browser and
 * the API enforce, and in the `test-photos` bucket's own policy, which Storage
 * enforces. They live where neither can import the other's source at runtime,
 * so this is where they are held to the same answer — a drift would make
 * Storage refuse an upload the app just approved, or accept one it refused.
 */
describe("test-photos bucket policy", () => {
	const bucket = BUCKETS["test-photos"];

	it("matches the app's size limit", () => {
		expect(bucket.fileSizeLimit).toBe(MAX_PHOTO_BYTES);
	});

	it("allows exactly the app's photo MIME types", () => {
		expect([...bucket.allowedMimeTypes].sort()).toEqual(
			[...PHOTO_CONTENT_TYPES].sort(),
		);
	});

	it("stays private, as does every other bucket", () => {
		for (const options of Object.values(BUCKETS)) {
			expect(options.public).toBe(false);
		}
	});
});
