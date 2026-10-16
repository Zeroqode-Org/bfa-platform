import { randomUUID } from "node:crypto";
import {
	DB_TESTS_ENABLED,
	requireDatabaseUrl,
} from "@bfa-platform/db/testing/db-tests";
import type { inferProcedureInput, inferProcedureOutput } from "@trpc/server";
import pg from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { MAX_PHOTO_BYTES } from "../lib/photo-rules";
import { PHOTO_SLOTS, photoSlotId, photoSlotPath } from "../lib/photo-storage";
import type { AppRouter } from "./index";

/**
 * The wizard's photo procedures against real Postgres: who may be handed a
 * signed upload URL, what file claims are refused before one is minted, and
 * which stored paths `getPhotoUrls` will sign.
 *
 * Storage is replaced by a recording stand-in — the `StorageAdmin` port exists
 * for exactly this — so no bytes move and no real signed URL is created; what
 * is asserted is whether, and for which key, the router would have asked.
 *
 * Opt-in: this suite writes real rows, so it runs only under `npm run test:db`.
 */

const storage = vi.hoisted(() => ({
	createSignedUploadUrl: vi.fn(async (_bucket: string, path: string) => ({
		signedUrl: `https://storage.test/upload/${path}`,
		token: "signed-token",
		path,
	})),
	createSignedDownloadUrl: vi.fn(
		async (_bucket: string, path: string) => `https://storage.test/${path}`,
	),
	upload: vi.fn(),
	download: vi.fn(),
	list: vi.fn(async () => [] as { name: string; createdAt: Date | null }[]),
	remove: vi.fn(async (_bucket: string, _paths: string[]) => {}),
}));

vi.mock("../lib/storage-admin", () => ({
	createStorageAdmin: () => storage,
}));

const describeDb = DB_TESTS_ENABLED ? describe : describe.skip;

type Wizard = AppRouter["certifierWizard"];
type Inputs = {
	[Procedure in keyof Wizard]: inferProcedureInput<Wizard[Procedure]>;
};
type Outputs = {
	[Procedure in keyof Wizard]: inferProcedureOutput<Wizard[Procedure]>;
};

/** Certifier A is active for `wp` and `wpSecond`; B only for `wp`. */
const wp = randomUUID();
const wpSecond = randomUUID();
/** A purveyor neither certifier is authorized for. */
const wpForeign = randomUUID();
const ids = {
	certifierProfileA: randomUUID(),
	certifierProfileB: randomUUID(),
};
const certifierA = randomUUID();
const certifierB = randomUUID();

const draftA = randomUUID();
const draftASecondWp = randomUUID();
const submittedA = randomUUID();
const draftB = randomUUID();
const draftForeignWp = randomUUID();

const HEIC = {
	extension: "heic",
	contentType: "image/heic",
	size: 1024,
} as const;

let pool: pg.Pool;

let callerFor: (profileId: string) => {
	certifierWizard: {
		getPhotoUploadUrl: (
			input: Inputs["getPhotoUploadUrl"],
		) => Promise<Outputs["getPhotoUploadUrl"]>;
		getPhotoUrls: (
			input: Inputs["getPhotoUrls"],
		) => Promise<Outputs["getPhotoUrls"]>;
	};
};

async function seedSubmission(
	id: string,
	certifierId: string,
	waterPurveyorId: string,
	status: "draft" | "submitted",
) {
	await pool.query(
		`insert into test_submissions
		   (id, certifier_id, water_purveyor_id, status, bfa_type, wizard_data,
		    current_step, test_date, test_result)
		 values ($1, $2, $3, $4::submission_status, 'RP', '{}'::jsonb, 1, $5, $6::test_result)`,
		[
			id,
			certifierId,
			waterPurveyorId,
			status,
			status === "submitted" ? "2027-05-01" : null,
			status === "submitted" ? "pass" : null,
		],
	);
}

describeDb("certifier wizard photo procedures", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

		const { t } = await import("../index");
		const { appRouter } = await import("./index");
		const createCaller = t.createCallerFactory(appRouter);

		callerFor = (profileId: string) =>
			createCaller({
				supabase: {} as never,
				user: { id: profileId } as never,
				resHeaders: new Headers(),
			}) as ReturnType<typeof callerFor>;

		await pool.query(
			`insert into water_purveyors (id, company_name, pwsid, status)
			 values ($1, 'Wizard Photo Fixture Water Works', 'WIZ-PHOTO', 'active'),
			        ($2, 'Wizard Photo Fixture Water Works — Second', 'WIZ-PHOTO-2', 'active'),
			        ($3, 'Wizard Photo Fixture Water Works — Foreign', 'WIZ-PHOTO-3', 'active')`,
			[wp, wpSecond, wpForeign],
		);

		for (const id of Object.values(ids)) {
			await pool.query(
				`insert into profiles (id, water_purveyor_id, full_name, global_role, status)
				 values ($1, null, 'Wizard Photo Fixture', 'certifier'::global_role, 'active')`,
				[id],
			);
		}

		await pool.query(
			`insert into certifiers (id, profile_id, company, id_number, license_expiration_date, status)
			 values ($1, $2, 'Photo Fixture A', 'PHOTO-A-1', '2029-01-01', 'active'),
			        ($3, $4, 'Photo Fixture B', 'PHOTO-B-1', '2029-01-01', 'active')`,
			[certifierA, ids.certifierProfileA, certifierB, ids.certifierProfileB],
		);

		await pool.query(
			`insert into wp_certifier_authorizations (certifier_id, water_purveyor_id, authorization_status)
			 values ($1, $2, 'active'),
			        ($1, $3, 'active'),
			        ($4, $2, 'active')`,
			[certifierA, wp, wpSecond, certifierB],
		);

		await seedSubmission(draftA, certifierA, wp, "draft");
		await seedSubmission(draftASecondWp, certifierA, wpSecond, "draft");
		await seedSubmission(submittedA, certifierA, wp, "submitted");
		await seedSubmission(draftB, certifierB, wp, "draft");
		// Certifier A's own row, under a purveyor they are not authorized for.
		await seedSubmission(draftForeignWp, certifierA, wpForeign, "draft");
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	afterAll(async () => {
		if (!pool) return;

		await pool.query(
			"delete from test_submissions where certifier_id = any($1::uuid[])",
			[[certifierA, certifierB]],
		);
		await pool.query(
			"delete from wp_certifier_authorizations where certifier_id = any($1::uuid[])",
			[[certifierA, certifierB]],
		);
		await pool.query("delete from certifiers where id = any($1::uuid[])", [
			[certifierA, certifierB],
		]);
		await pool.query("delete from profiles where id = any($1::uuid[])", [
			Object.values(ids),
		]);
		await pool.query("delete from water_purveyors where id = any($1::uuid[])", [
			[wp, wpSecond, wpForeign],
		]);
		await pool.end();
	});

	describe("getPhotoUploadUrl", () => {
		it("mints a server-chosen key with the canonical extension for the draft's owner", async () => {
			for (const claim of [
				{ extension: "jpg", contentType: "image/jpeg" },
				{ extension: "png", contentType: "image/png" },
				{ extension: "heic", contentType: "image/heic" },
			] as const) {
				const result = await callerFor(
					ids.certifierProfileA,
				).certifierWizard.getPhotoUploadUrl({
					id: draftA,
					waterPurveyorId: wp,
					...claim,
					size: MAX_PHOTO_BYTES,
				});

				expect(result.token).toBe("signed-token");
				expect(result.path).toMatch(
					new RegExp(
						`^${draftA}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${claim.extension}$`,
					),
				);
				expect(storage.createSignedUploadUrl).toHaveBeenLastCalledWith(
					"test-photos",
					result.path,
				);
			}
		});

		it("takes the first free fixed slot, so the keys one draft can use are bounded", async () => {
			const longAgo = new Date(Date.now() - 60 * 60 * 1000);
			storage.list.mockResolvedValueOnce([
				{ name: `${photoSlotId(draftA, 0)}.jpg`, createdAt: longAgo },
			]);

			const result = await callerFor(
				ids.certifierProfileA,
			).certifierWizard.getPhotoUploadUrl({
				id: draftA,
				waterPurveyorId: wp,
				...HEIC,
				keep: [photoSlotPath(draftA, 0, "jpg")],
			});

			expect(result.path).toBe(photoSlotPath(draftA, 1, "heic"));
			expect(storage.remove).toHaveBeenCalledWith("test-photos", []);
		});

		it("prunes photos the form no longer shows, freeing their slots", async () => {
			const longAgo = new Date(Date.now() - 60 * 60 * 1000);
			storage.list.mockResolvedValueOnce([
				{ name: `${photoSlotId(draftA, 0)}.jpg`, createdAt: longAgo },
				{ name: `${photoSlotId(draftA, 1)}.png`, createdAt: longAgo },
			]);

			const result = await callerFor(
				ids.certifierProfileA,
			).certifierWizard.getPhotoUploadUrl({
				id: draftA,
				waterPurveyorId: wp,
				...HEIC,
				// Slot 1 is kept; slot 0 was removed, and a foreign path is ignored.
				keep: [
					photoSlotPath(draftA, 1, "png"),
					photoSlotPath(draftB, 0, "jpg"),
				],
			});

			expect(storage.remove).toHaveBeenCalledWith("test-photos", [
				photoSlotPath(draftA, 0, "jpg"),
			]);
			expect(result.path).toBe(photoSlotPath(draftA, 0, "heic"));
		});

		it("mints nothing while every slot is still taken", async () => {
			storage.list.mockResolvedValueOnce(
				Array.from({ length: PHOTO_SLOTS }, (_, slot) => ({
					name: `${photoSlotId(draftA, slot)}.jpg`,
					// Just uploaded: too new to prune, even though not kept.
					createdAt: new Date(),
				})),
			);

			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
					id: draftA,
					waterPurveyorId: wp,
					...HEIC,
				}),
			).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
			expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
		});

		it("refuses another certifier's draft as not found, minting nothing", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
					id: draftB,
					waterPurveyorId: wp,
					...HEIC,
				}),
			).rejects.toThrow(/draft not found/i);
			expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
		});

		it("refuses the caller's own draft asked for under a different authorized purveyor, the same way", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
					id: draftASecondWp,
					waterPurveyorId: wp,
					...HEIC,
				}),
			).rejects.toThrow(/draft not found/i);
			expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
		});

		it("refuses a submitted test, the same way", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
					id: submittedA,
					waterPurveyorId: wp,
					...HEIC,
				}),
			).rejects.toThrow(/draft not found/i);
			expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
		});

		it("refuses an id that never existed, the same way", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
					id: randomUUID(),
					waterPurveyorId: wp,
					...HEIC,
				}),
			).rejects.toThrow(/draft not found/i);
		});

		it("refuses a purveyor the caller is not authorized for, even for their own row", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
					id: draftForeignWp,
					waterPurveyorId: wpForeign,
					...HEIC,
				}),
			).rejects.toThrow(/not authorized/i);
			expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
		});

		it("refuses unsupported or oversized file claims before minting a URL", async () => {
			for (const claim of [
				{ extension: "pdf", contentType: "application/pdf", size: 10 },
				{ extension: "jpeg", contentType: "image/jpeg", size: 10 },
				{ extension: "jpg", contentType: "image/heic", size: 10 },
				{ extension: "heif", contentType: "image/heif", size: 10 },
				{ extension: "png", contentType: "image/png", size: 0 },
				{
					extension: "png",
					contentType: "image/png",
					size: MAX_PHOTO_BYTES + 1,
				},
			]) {
				await expect(
					callerFor(ids.certifierProfileA).certifierWizard.getPhotoUploadUrl({
						id: draftA,
						waterPurveyorId: wp,
						...(claim as unknown as typeof HEIC),
					}),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });
			}
			expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
		});
	});

	describe("getPhotoUrls", () => {
		const uuid = "33333333-3333-4333-8333-333333333333";

		it("signs only this test's own, server-shaped paths", async () => {
			const own = `${draftA}/${uuid}.heic`;
			const ownPng = `${draftA}/${uuid}.png`;

			const urls = await callerFor(
				ids.certifierProfileA,
			).certifierWizard.getPhotoUrls({
				id: draftA,
				waterPurveyorId: wp,
				paths: [own, ownPng],
			});

			expect(urls).toEqual({
				[own]: `https://storage.test/${own}`,
				[ownPng]: `https://storage.test/${ownPng}`,
			});
		});

		it("never signs another draft's path, traversal or an unlisted extension", async () => {
			for (const path of [
				`${draftB}/${uuid}.jpg`,
				`${draftA}/../${draftB}/${uuid}.jpg`,
				`${draftA}/${uuid}.pdf`,
				`${draftA}/${uuid}.jpeg`,
				`${draftA}/anything.jpg`,
				`${draftA}/${draftB}/${uuid}.jpg`,
			]) {
				const urls = await callerFor(
					ids.certifierProfileA,
				).certifierWizard.getPhotoUrls({
					id: draftA,
					waterPurveyorId: wp,
					paths: [path],
				});

				expect(urls).toEqual({});
			}
			expect(storage.createSignedDownloadUrl).not.toHaveBeenCalled();
		});

		it("skips a photo already gone from Storage without failing the rest", async () => {
			const gone = `${draftA}/${uuid}.jpg`;
			const present = `${draftA}/${uuid}.png`;
			storage.createSignedDownloadUrl.mockRejectedValueOnce(
				new Error("Object not found"),
			);

			const urls = await callerFor(
				ids.certifierProfileA,
			).certifierWizard.getPhotoUrls({
				id: draftA,
				waterPurveyorId: wp,
				paths: [gone, present],
			});

			expect(urls).toEqual({ [present]: `https://storage.test/${present}` });
		});

		it("refuses another certifier's test outright", async () => {
			await expect(
				callerFor(ids.certifierProfileA).certifierWizard.getPhotoUrls({
					id: draftB,
					waterPurveyorId: wp,
					paths: [`${draftB}/${uuid}.jpg`],
				}),
			).rejects.toThrow(/draft not found/i);
			expect(storage.createSignedDownloadUrl).not.toHaveBeenCalled();
		});
	});
});
