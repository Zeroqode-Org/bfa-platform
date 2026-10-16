import { afterEach, describe, expect, it, vi } from "vitest";

import { isOwnPhotoPath, parsePhotoPath } from "./photo-rules";
import {
	discardUnusedPhotos,
	freePhotoSlot,
	PHOTO_SLOTS,
	photoSlotId,
	photoSlotPath,
	prunePhotoFolder,
} from "./photo-storage";
import type { StorageAdmin } from "./storage-admin";

/**
 * The fixed-slot keys and folder pruning on their own, against an in-memory
 * stand-in for Storage — what bounds how many objects one test can create.
 */

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fakeStorage(objects: { name: string; createdAt: Date | null }[]) {
	const remove = vi.fn(async (_bucket: string, _paths: string[]) => {});
	const list = vi.fn(async () => objects);
	const storage = { list, remove } as unknown as StorageAdmin;

	return { storage, list, remove };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("photo slots", () => {
	it("derives a fixed, UUID-shaped id per test and slot", () => {
		expect(photoSlotId(id, 0)).toBe(photoSlotId(id.toUpperCase(), 0));
		expect(photoSlotId(id, 0)).not.toBe(photoSlotId(id, 1));
		expect(photoSlotId(id, 0)).not.toBe(photoSlotId(other, 0));
		expect(photoSlotId(id, 3)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("builds keys the stored-path rule accepts, in the test's own folder", () => {
		for (let slot = 0; slot < PHOTO_SLOTS; slot++) {
			const path = photoSlotPath(id.toUpperCase(), slot, "heic");

			expect(parsePhotoPath(path)).toEqual({
				submissionId: id,
				extension: "heic",
			});
			expect(isOwnPhotoPath(id, path)).toBe(true);
			expect(isOwnPhotoPath(other, path)).toBe(false);
		}
	});

	it("picks the first slot with no object, whatever its extension", () => {
		expect(freePhotoSlot(id, [])).toBe(0);
		expect(
			freePhotoSlot(id, [
				`${photoSlotId(id, 0)}.png`,
				"legacy-name.jpg",
				`${photoSlotId(id, 2)}.jpg`,
			]),
		).toBe(1);
	});

	it("has no free slot once every one is taken", () => {
		const names = Array.from(
			{ length: PHOTO_SLOTS },
			(_, slot) => `${photoSlotId(id, slot)}.jpg`,
		);

		expect(freePhotoSlot(id, names)).toBeNull();
	});
});

describe("prunePhotoFolder", () => {
	const cutoff = new Date("2026-10-16T12:00:00Z");
	const before = new Date("2026-10-16T11:00:00Z");
	const after = new Date("2026-10-16T12:00:30Z");

	it("deletes unreferenced objects older than the cutoff and keeps the rest", async () => {
		const { storage, list, remove } = fakeStorage([
			{ name: "kept.jpg", createdAt: before },
			{ name: "removed.jpg", createdAt: before },
			{ name: "just-uploaded.png", createdAt: after },
			{ name: "undated.heic", createdAt: null },
		]);

		const remaining = await prunePhotoFolder(
			storage,
			id,
			[`${id}/kept.jpg`],
			cutoff,
		);

		expect(list).toHaveBeenCalledWith("test-photos", id);
		expect(remove).toHaveBeenCalledWith("test-photos", [
			`${id}/removed.jpg`,
			`${id}/undated.heic`,
		]);
		expect(remaining).toEqual(["kept.jpg", "just-uploaded.png"]);
	});
});

describe("discardUnusedPhotos", () => {
	it("removes everything not kept, however new", async () => {
		const { storage, remove } = fakeStorage([
			{ name: "kept.jpg", createdAt: new Date() },
			{ name: "fresh.jpg", createdAt: new Date() },
		]);

		await discardUnusedPhotos(storage, id, [`${id}/kept.jpg`]);

		expect(remove).toHaveBeenCalledWith("test-photos", [`${id}/fresh.jpg`]);
	});

	it("logs a failure as structured JSON instead of throwing", async () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
		const storage = {
			list: vi.fn(async () => {
				throw new Error("storage down");
			}),
			remove: vi.fn(),
		} as unknown as StorageAdmin;

		await expect(discardUnusedPhotos(storage, id, [])).resolves.toBeUndefined();
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "test_photo_cleanup_failed",
			target_submission_id: id,
			error: "storage down",
		});
	});
});
