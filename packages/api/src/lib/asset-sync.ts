import type { db } from "@bfa-platform/db";
import {
	bfaAssets,
	customerAssignments,
	customers,
	testSubmissions,
} from "@bfa-platform/db/schema";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { JobExecutor } from "../scheduler/jobs";
import { resumeHeldNoticeChain } from "../scheduler/notice-chain";
import { ASSET_FIELD_LIMITS } from "./asset-field-limits";
import { type AuditActor, auditActorFields } from "./audit-actor";
import { CUSTOMER_FIELD_LIMITS } from "./customer-field-limits";
import {
	ASSEMBLY_FIELD_KEYS,
	CUSTOMER_EMAIL_KEY,
	CUSTOMER_NAME_KEY,
} from "./wizard-input";

/**
 * Carrying what a test changed about its assembly back onto the asset
 * (client, October 2026).
 *
 * A test records the assembly as it was found: a certifier may overwrite any
 * prefilled detail, and a purveyor may correct any field afterward. Both used
 * to stay on the test alone, leaving the register to disagree with the latest
 * visit. Now:
 *
 * - **A certifier's submit** writes the details they overwrote (the fields in
 *   `overridden_fields`) onto the asset.
 * - **A purveyor's correction** writes the details changed *in that save* —
 *   never the untouched ones, which may have been corrected on the asset's
 *   own page since.
 *
 * Only from the asset's **latest** submitted test (newest test date, then
 * newest filed). Correcting last year's test must not put last year's address
 * back on the register.
 *
 * What counts as the asset's: the six assembly details, the BFA type, and the
 * customer. The customer follows the email — the key customers are unique on
 * per purveyor. The same email as the current occupant's renames them if the
 * name changed; a different one finds that customer (or creates them) and
 * moves the asset to them, closing the old occupancy row the way
 * `assignCustomer` does.
 *
 * Runs inside the caller's transaction; returns the log lines to emit once it
 * commits, so a rolled-back save leaves no trace in the audit stream.
 */

/** The wizard keys of the assembly details, and the asset column each fills. */
const DETAIL_COLUMNS = {
	[ASSEMBLY_FIELD_KEYS.serviceAddress]: "serviceAddress",
	[ASSEMBLY_FIELD_KEYS.make]: "make",
	[ASSEMBLY_FIELD_KEYS.model]: "model",
	[ASSEMBLY_FIELD_KEYS.serialNumber]: "serialNumber",
	[ASSEMBLY_FIELD_KEYS.size]: "size",
	[ASSEMBLY_FIELD_KEYS.location]: "assemblyLocation",
} as const;

type DetailColumn = (typeof DETAIL_COLUMNS)[keyof typeof DETAIL_COLUMNS];

const DETAIL_LIMITS: Record<DetailColumn, number> = {
	serviceAddress: ASSET_FIELD_LIMITS.serviceAddress,
	make: ASSET_FIELD_LIMITS.make,
	model: ASSET_FIELD_LIMITS.model,
	serialNumber: ASSET_FIELD_LIMITS.serialNumber,
	size: ASSET_FIELD_LIMITS.size,
	assemblyLocation: ASSET_FIELD_LIMITS.assemblyLocation,
};

/** The key a changed BFA type is named by in `fields`. */
export const BFA_TYPE_FIELD = "bfaType";

export type AssetSyncLog = { event: string; extra: Record<string, unknown> };

export async function syncAssetFromSubmission({
	executor,
	submissionId,
	assetId,
	waterPurveyorId,
	fields,
	bfaType,
	wizardData,
	actor,
}: {
	executor: JobExecutor;
	submissionId: string;
	assetId: string;
	waterPurveyorId: string;
	/** Which answers to carry over: wizard keys, plus `bfaType`. */
	fields: Iterable<string>;
	bfaType: string;
	wizardData: Record<string, unknown>;
	actor: AuditActor | null;
}): Promise<AssetSyncLog[]> {
	const wanted = new Set(fields);
	const touchesCustomer =
		wanted.has(CUSTOMER_NAME_KEY) || wanted.has(CUSTOMER_EMAIL_KEY);
	const touchesAsset =
		wanted.has(BFA_TYPE_FIELD) ||
		Object.keys(DETAIL_COLUMNS).some((key) => wanted.has(key));

	if (!touchesAsset && !touchesCustomer) return [];

	if (
		!(await isLatestForAsset(executor, submissionId, assetId, waterPurveyorId))
	) {
		return [];
	}

	const [asset] = await executor
		.select({
			id: bfaAssets.id,
			bin: bfaAssets.bin,
			bfaType: bfaAssets.bfaType,
			serviceAddress: bfaAssets.serviceAddress,
			make: bfaAssets.make,
			model: bfaAssets.model,
			serialNumber: bfaAssets.serialNumber,
			size: bfaAssets.size,
			assemblyLocation: bfaAssets.assemblyLocation,
			currentCustomerId: bfaAssets.currentCustomerId,
		})
		.from(bfaAssets)
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	if (!asset) return [];

	const logs: AssetSyncLog[] = [];
	const updates: Partial<typeof bfaAssets.$inferInsert> = {};

	for (const [key, column] of Object.entries(DETAIL_COLUMNS)) {
		if (!wanted.has(key)) continue;

		const value = answerText(wizardData[key], DETAIL_LIMITS[column]);

		// Every asset has an address; a blank one on the test is not a reason
		// to erase it from the register.
		if (column === "serviceAddress" && !value) continue;
		if (asset[column] !== value) {
			// `serviceAddress` is never null here — the blank case returned above.
			(updates as Record<DetailColumn, string | null>)[column] = value;
		}
	}

	if (wanted.has(BFA_TYPE_FIELD) && bfaType !== asset.bfaType) {
		updates.bfaType = bfaType as typeof asset.bfaType;
	}

	if (Object.keys(updates).length > 0) {
		await executor
			.update(bfaAssets)
			.set(updates)
			.where(
				and(
					eq(bfaAssets.id, asset.id),
					eq(bfaAssets.waterPurveyorId, waterPurveyorId),
				),
			);

		logs.push({
			event: "bfa_asset_updated_from_test",
			extra: {
				asset_id: asset.id,
				bin: asset.bin,
				// Names, not values — the same rule as `test_submission_corrected`.
				changed_fields: Object.keys(updates),
			},
		});
	}

	if (touchesCustomer) {
		logs.push(
			...(await syncCustomer({
				executor,
				asset,
				waterPurveyorId,
				wizardData,
				renameAllowed: wanted.has(CUSTOMER_NAME_KEY),
				reassignAllowed: wanted.has(CUSTOMER_EMAIL_KEY),
				actor,
			})),
		);
	}

	return logs;
}

/** Every answer that belongs to the asset rather than to the test alone. */
export const ASSET_ANSWER_KEYS: ReadonlySet<string> = new Set([
	...Object.keys(DETAIL_COLUMNS),
	BFA_TYPE_FIELD,
	CUSTOMER_NAME_KEY,
	CUSTOMER_EMAIL_KEY,
]);

/**
 * Which of the asset's answers this test records differently from the
 * register as it stands — computed here, never taken from the client.
 *
 * `submitTest` keeps a certifier's "overwritten" flag on an asset answer only
 * when this says the value really differs. A request that flags `bfaType` or
 * the customer without changing them therefore writes nothing to the asset
 * and records nothing false on the test; a real change on site still does
 * both.
 */
export async function differingAssetAnswers({
	executor,
	assetId,
	waterPurveyorId,
	bfaType,
	wizardData,
}: {
	executor: Pick<typeof db, "select">;
	assetId: string;
	waterPurveyorId: string;
	bfaType: string;
	wizardData: Record<string, unknown>;
}): Promise<Set<string>> {
	const [asset] = await executor
		.select({
			bfaType: bfaAssets.bfaType,
			serviceAddress: bfaAssets.serviceAddress,
			make: bfaAssets.make,
			model: bfaAssets.model,
			serialNumber: bfaAssets.serialNumber,
			size: bfaAssets.size,
			assemblyLocation: bfaAssets.assemblyLocation,
			customerName: customers.name,
			customerEmail: customers.email,
		})
		.from(bfaAssets)
		.leftJoin(
			customers,
			and(
				eq(customers.id, bfaAssets.currentCustomerId),
				eq(customers.waterPurveyorId, waterPurveyorId),
			),
		)
		.where(
			and(
				eq(bfaAssets.id, assetId),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		)
		.limit(1);

	const differing = new Set<string>();

	if (!asset) return differing;

	for (const [key, column] of Object.entries(DETAIL_COLUMNS)) {
		if (answerText(wizardData[key], DETAIL_LIMITS[column]) !== asset[column]) {
			differing.add(key);
		}
	}

	if (bfaType !== asset.bfaType) differing.add(BFA_TYPE_FIELD);

	const name = answerText(
		wizardData[CUSTOMER_NAME_KEY],
		CUSTOMER_FIELD_LIMITS.name,
	);
	if (name !== (asset.customerName ?? null)) differing.add(CUSTOMER_NAME_KEY);

	const email = wizardCustomerEmail(wizardData[CUSTOMER_EMAIL_KEY]);
	const currentEmail = asset.customerEmail?.trim().toLowerCase() ?? null;
	if (email !== currentEmail) differing.add(CUSTOMER_EMAIL_KEY);

	return differing;
}

/** Emits the lines `syncAssetFromSubmission` returned, after the commit. */
export function logAssetSync(
	logs: AssetSyncLog[],
	{
		actor,
		submissionId,
		waterPurveyorId,
	}: {
		actor: AuditActor | null;
		submissionId: string;
		waterPurveyorId: string;
	},
) {
	for (const { event, extra } of logs) {
		console.log(
			JSON.stringify({
				event,
				...auditActorFields(actor),
				submission_id: submissionId,
				wp_id: waterPurveyorId,
				...extra,
				timestamp: new Date().toISOString(),
			}),
		);
	}
}

/**
 * The wizard keys whose answer differs between two `wizard_data` bags —
 * what a purveyor's save actually changed, at the level of one answer.
 */
export function changedWizardKeys(
	before: unknown,
	after: Record<string, unknown>,
): string[] {
	const old =
		typeof before === "object" && before !== null
			? (before as Record<string, unknown>)
			: {};
	const keys = new Set([...Object.keys(old), ...Object.keys(after)]);

	return [...keys].filter((key) => !Object.is(old[key], after[key]));
}

/**
 * The purveyor's customer with this email, or a new one when there is none.
 *
 * Matched the way the per-purveyor unique index compares — `lower(btrim())` —
 * so it finds exactly the customer a duplicate insert would collide with. A
 * new customer needs a name; without one, nobody is returned.
 *
 * `on conflict do nothing` then a re-read, rather than catching the violation:
 * inside a transaction a failed insert aborts everything after it, and a
 * second clerk creating the same customer a moment earlier is not an error
 * here — it is the customer to use.
 */
export async function findOrCreateCustomer(
	executor: Pick<typeof db, "select" | "insert">,
	waterPurveyorId: string,
	{ name, email }: { name: string | null; email: string },
) {
	const findExisting = async () => {
		const [row] = await executor
			.select({ id: customers.id, status: customers.status })
			.from(customers)
			.where(
				and(
					eq(customers.waterPurveyorId, waterPurveyorId),
					sql`lower(btrim(${customers.email})) = ${email}`,
				),
			)
			.limit(1);

		return row ? { ...row, created: false } : null;
	};

	const found = await findExisting();

	if (found || !name) return found;

	const [inserted] = await executor
		.insert(customers)
		.values({ waterPurveyorId, name, email })
		.onConflictDoNothing()
		.returning({ id: customers.id, status: customers.status });

	return inserted ? { ...inserted, created: true } : findExisting();
}

/** A wizard customer email, normalised as `customer-input.ts` stores one, or null. */
export function wizardCustomerEmail(value: unknown): string | null {
	const email = answerText(value, CUSTOMER_FIELD_LIMITS.email)?.toLowerCase();

	return email && z.email().safeParse(email).success ? email : null;
}

/**
 * Whether this submission is the asset's latest submitted test — newest test
 * date, then newest filed, the order every test list here uses.
 */
async function isLatestForAsset(
	executor: Pick<typeof db, "select">,
	submissionId: string,
	assetId: string,
	waterPurveyorId: string,
) {
	const [latest] = await executor
		.select({ id: testSubmissions.id })
		.from(testSubmissions)
		.where(
			and(
				eq(testSubmissions.bfaAssetId, assetId),
				eq(testSubmissions.waterPurveyorId, waterPurveyorId),
				eq(testSubmissions.status, "submitted"),
			),
		)
		.orderBy(
			sql`${testSubmissions.testDate} desc nulls last`,
			desc(testSubmissions.createdAt),
			asc(testSubmissions.id),
		)
		.limit(1);

	return latest?.id === submissionId;
}

/**
 * The test's customer onto the asset. Same email as the current occupant:
 * rename them if the name changed (and the name was one of the fields being
 * carried). Different email: that customer — found or created — becomes the
 * occupant, with the occupancy history closed and opened as `assignCustomer`
 * does it, and a held notice chain resumed for an active one.
 */
async function syncCustomer({
	executor,
	asset,
	waterPurveyorId,
	wizardData,
	renameAllowed,
	reassignAllowed,
	actor,
}: {
	executor: JobExecutor;
	asset: { id: string; bin: string | null; currentCustomerId: string | null };
	waterPurveyorId: string;
	wizardData: Record<string, unknown>;
	renameAllowed: boolean;
	/** Whether the email was among the answers carried — see below. */
	reassignAllowed: boolean;
	actor: AuditActor | null;
}): Promise<AssetSyncLog[]> {
	const email = wizardCustomerEmail(wizardData[CUSTOMER_EMAIL_KEY]);
	const name = answerText(
		wizardData[CUSTOMER_NAME_KEY],
		CUSTOMER_FIELD_LIMITS.name,
	);

	// No usable email: nothing to match a customer by.
	if (!email) return [];

	const [current] = asset.currentCustomerId
		? await executor
				.select({
					id: customers.id,
					name: customers.name,
					email: customers.email,
				})
				.from(customers)
				.where(
					and(
						eq(customers.id, asset.currentCustomerId),
						eq(customers.waterPurveyorId, waterPurveyorId),
					),
				)
				.limit(1)
		: [];

	if (current && current.email.trim().toLowerCase() === email) {
		if (!renameAllowed || !name || name === current.name) return [];

		await executor
			.update(customers)
			.set({
				name,
				// The customer form's optimistic lock: a form opened before this
				// rename is refused rather than allowed to put the old name back.
				revision: sql`${customers.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(customers.id, current.id),
					eq(customers.waterPurveyorId, waterPurveyorId),
				),
			);

		return [
			{
				event: "customer_updated_from_test",
				extra: { customer_id: current.id, changed_fields: ["name"] },
			},
		];
	}

	// Moving the asset to another customer takes a changed email. A save that
	// only renamed carries the test's email unchanged — and if the asset has
	// been moved to someone else on its own page since the test, that email is
	// the *old* occupant's, so acting on it would move the asset back.
	if (!reassignAllowed) return [];

	const customer = await findOrCreateCustomer(executor, waterPurveyorId, {
		name,
		email,
	});

	if (!customer || customer.id === asset.currentCustomerId) return [];

	await executor
		.update(customerAssignments)
		.set({ endDate: sql`current_date` })
		.where(
			and(
				eq(customerAssignments.bfaAssetId, asset.id),
				isNull(customerAssignments.endDate),
				// The asset was read inside this purveyor; scoping the history
				// through it again keeps the write bounded on its own.
				inArray(
					customerAssignments.bfaAssetId,
					executor
						.select({ id: bfaAssets.id })
						.from(bfaAssets)
						.where(eq(bfaAssets.waterPurveyorId, waterPurveyorId)),
				),
			),
		);

	await executor.insert(customerAssignments).values({
		bfaAssetId: asset.id,
		customerId: customer.id,
		startDate: sql`current_date`,
	});

	await executor
		.update(bfaAssets)
		.set({ currentCustomerId: customer.id })
		.where(
			and(
				eq(bfaAssets.id, asset.id),
				eq(bfaAssets.waterPurveyorId, waterPurveyorId),
			),
		);

	if (customer.status === "active") {
		await resumeHeldNoticeChain({
			executor,
			assetId: asset.id,
			waterPurveyorId,
			actor,
		});
	}

	const logs: AssetSyncLog[] = [];

	if (customer.created) {
		logs.push({
			event: "customer_created",
			extra: {
				customer_id: customer.id,
				rate_category: "standard",
				status: customer.status,
				source: "test_submission",
			},
		});
	}

	logs.push({
		event: "bfa_asset_customer_assigned",
		extra: {
			asset_id: asset.id,
			bin: asset.bin,
			from: asset.currentCustomerId,
			to: customer.id,
			to_customer_suspended: customer.status === "suspended",
			source: "test_submission",
		},
	});

	return logs;
}

/** A wizard answer as trimmed, capped text, or null when there is nothing in it. */
function answerText(value: unknown, max: number): string | null {
	if (typeof value === "number") return String(value).slice(0, max);
	if (typeof value !== "string") return null;

	return value.trim().slice(0, max) || null;
}
