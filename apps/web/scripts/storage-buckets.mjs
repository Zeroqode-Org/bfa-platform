// The Storage buckets `supabase-setup.mjs` provisions, each with its full
// desired configuration. Kept apart from the setup script, which connects and
// exits on import, so `storage-buckets.test.ts` can read it.
//
// `test-photos` carries the closing-block photo contract as a second barrier,
// independent of the app's own checks. It must match
// `packages/api/src/lib/photo-rules.ts` (a .mjs script cannot import that
// TypeScript module) — `storage-buckets.test.ts` fails when the two drift.
// A bucket with no limits is only ensured to exist and be private; its other
// settings are left as they are.
export const BUCKETS = {
	"test-photos": {
		public: false,
		allowedMimeTypes: ["image/jpeg", "image/png", "image/heic"],
		// 25 MB (25 × 1024² bytes). Storage refuses a bucket limit above the
		// project's global upload limit (Storage Settings; 50 MB at most on Free).
		fileSizeLimit: 25 * 1024 ** 2,
	},
	"result-documents": { public: false },
};
