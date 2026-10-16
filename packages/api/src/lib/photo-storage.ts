import { createHash } from "node:crypto";

import type { PhotoExtension } from "./photo-rules";
import type { StorageAdmin } from "./storage-admin";

/**
 * Where a test's photos live in Storage, and how many objects one test can
 * ever put there. Server-only (`node:crypto`); the shared, browser-safe rules
 * are in `photo-rules.ts`.
 *
 * Upload keys are not random. Each test has `PHOTO_SLOTS` fixed object ids,
 * derived from its own id, and `getPhotoUploadUrl` only ever signs a free one.
 * A signed upload URL lives two hours and Storage cannot be told to expire it
 * sooner, so counting objects alone would not cap anything: a client could ask
 * for a hundred URLs before uploading to any. With fixed ids, a hundred
 * requests still name the same few keys, and a second upload to a taken key is
 * refused (the URLs are minted without upsert) — so one test holds at most
 * `PHOTO_SLOTS` × three extensions objects, whatever the client does.
 *
 * Slots are freed by `prunePhotoFolder`, which deletes the objects a test no
 * longer uses — removed photos, uploads that never made it into the form.
 */

export const PHOTO_BUCKET = "test-photos";

/** Two kept photos, plus room to replace each once before the next prune. */
export const PHOTO_SLOTS = 4;

/**
 * How old an unreferenced object must be before a prune deletes it. A photo
 * that finished uploading moments before the request was built is not in its
 * `keep` list yet; this margin keeps it from being deleted out from under the
 * form that is about to add it.
 */
export const PRUNE_GRACE_MS = 60_000;

/** The fixed object id of one of a test's slots, shaped as a UUID. */
export function photoSlotId(submissionId: string, slot: number): string {
	const hex = createHash("sha256")
		.update(`test-photo:${submissionId.toLowerCase()}:${slot}`)
		.digest("hex");

	// Version 4 and RFC 4122 variant nibbles, so the id reads as a normal UUID.
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		`${"89ab"[Number.parseInt(hex[16] ?? "0", 16) % 4]}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
}

/** The object key of a slot: `<test id>/<slot id>.<extension>`. */
export function photoSlotPath(
	submissionId: string,
	slot: number,
	extension: PhotoExtension,
): string {
	return `${submissionId.toLowerCase()}/${photoSlotId(submissionId, slot)}.${extension}`;
}

/** The first slot with no object in it, given the folder's object names; null when every slot is taken. */
export function freePhotoSlot(
	submissionId: string,
	objectNames: string[],
): number | null {
	const taken = new Set(objectNames.map((name) => name.split(".")[0]));

	for (let slot = 0; slot < PHOTO_SLOTS; slot++) {
		if (!taken.has(photoSlotId(submissionId, slot))) return slot;
	}

	return null;
}

/**
 * Deletes the objects in a test's folder that are not in `keep` and were
 * created before `cutoff`, and returns the names of the objects left.
 */
export async function prunePhotoFolder(
	storage: StorageAdmin,
	submissionId: string,
	keep: string[],
	cutoff: Date,
): Promise<string[]> {
	const folder = submissionId.toLowerCase();
	const kept = new Set(keep);
	const objects = await storage.list(PHOTO_BUCKET, folder);
	const stale = objects.filter(
		(object) =>
			!kept.has(`${folder}/${object.name}`) &&
			(object.createdAt === null || object.createdAt < cutoff),
	);

	await storage.remove(
		PHOTO_BUCKET,
		stale.map((object) => `${folder}/${object.name}`),
	);

	const removed = new Set(stale);
	return objects
		.filter((object) => !removed.has(object))
		.map((object) => object.name);
}

/**
 * Best-effort clean-up after a test's photo set becomes final (submitted) or
 * the test is gone (deleted draft): every object not in `keep` goes. A
 * failure is logged, never thrown — the test itself is already committed, and
 * a leftover object is only wasted space in a private bucket.
 */
export async function discardUnusedPhotos(
	storage: StorageAdmin,
	submissionId: string,
	keep: string[],
): Promise<void> {
	try {
		await prunePhotoFolder(
			storage,
			submissionId,
			keep,
			new Date(Date.now() + PRUNE_GRACE_MS),
		);
	} catch (error) {
		console.log(
			JSON.stringify({
				event: "test_photo_cleanup_failed",
				target_submission_id: submissionId,
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			}),
		);
	}
}
