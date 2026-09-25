import { env as serverEnv } from "@bfa-platform/env/server";
import { env as webEnv } from "@bfa-platform/env/web";
import { createClient } from "@supabase/supabase-js";

/**
 * The slice of Supabase Storage the wizard needs, against the two buckets
 * `apps/web/scripts/supabase-setup.mjs` already provisions (`test-photos`,
 * `result-documents`, both private).
 *
 * Declared as a port for the same reason `auth-admin.ts` is: it lets the
 * wizard's tests stand in for Storage rather than uploading real bytes to a
 * shared project on every run.
 */
export type StorageAdmin = {
	createSignedUploadUrl(
		bucket: string,
		path: string,
	): Promise<{ signedUrl: string; token: string; path: string }>;
	upload(
		bucket: string,
		path: string,
		body: Buffer,
		contentType: string,
	): Promise<void>;
	createSignedDownloadUrl(
		bucket: string,
		path: string,
		expiresInSeconds: number,
	): Promise<string>;
	download(bucket: string, path: string): Promise<Buffer>;
};

/**
 * Service-role Supabase client — bypasses RLS, server-only. Same construction
 * as `auth-admin.ts`'s own `createServiceClient`; kept as a second private
 * copy rather than a shared export, matching that file's own reasoning: each
 * caller's port is independently testable without one growing to serve both.
 */
function createServiceClient() {
	return createClient(
		webEnv.NEXT_PUBLIC_SUPABASE_URL,
		serverEnv.SUPABASE_SERVICE_ROLE_KEY,
		{ auth: { persistSession: false, autoRefreshToken: false } },
	);
}

export function createStorageAdmin(): StorageAdmin {
	const supabase = createServiceClient();

	return {
		async createSignedUploadUrl(bucket, path) {
			const { data, error } = await supabase.storage
				.from(bucket)
				.createSignedUploadUrl(path);

			if (error || !data) {
				throw new Error(
					`Could not create a signed upload URL: ${error?.message}`,
				);
			}

			return { signedUrl: data.signedUrl, token: data.token, path: data.path };
		},

		async upload(bucket, path, body, contentType) {
			const { error } = await supabase.storage
				.from(bucket)
				.upload(path, body, { contentType, upsert: true });

			if (error) {
				throw new Error(
					`Could not upload to ${bucket}/${path}: ${error.message}`,
				);
			}
		},

		async createSignedDownloadUrl(bucket, path, expiresInSeconds) {
			const { data, error } = await supabase.storage
				.from(bucket)
				.createSignedUrl(path, expiresInSeconds);

			if (error || !data) {
				throw new Error(
					`Could not create a signed download URL: ${error?.message}`,
				);
			}

			return data.signedUrl;
		},

		async download(bucket, path) {
			const { data, error } = await supabase.storage
				.from(bucket)
				.download(path);

			if (error || !data) {
				throw new Error(
					`Could not download ${bucket}/${path}: ${error?.message}`,
				);
			}

			return Buffer.from(await data.arrayBuffer());
		},
	};
}
