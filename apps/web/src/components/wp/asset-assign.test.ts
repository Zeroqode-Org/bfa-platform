import { describe, expect, it } from "vitest";

import { nextAssignAction } from "./asset-types";

/**
 * The attach-a-customer decision, on its own.
 *
 * The rule lives in one pure function rather than inside the dialog, because it
 * is the part worth checking: which choices are dead ends, and which one has to
 * be confirmed before it is sent. `assignCustomer` enforces the same three
 * outcomes server-side — `packages/api/src/routers/assets.test.ts` covers that
 * half, and this one only says the screen agrees.
 */

const active = { id: "customer-a", status: "active" as const };
const suspended = { id: "customer-b", status: "suspended" as const };

describe("nextAssignAction", () => {
	it("does nothing until a customer is chosen", () => {
		expect(
			nextAssignAction({
				customer: undefined,
				currentCustomerId: null,
				suspensionConfirmed: false,
			}),
		).toBe("blocked");
	});

	it("does nothing for the customer already attached", () => {
		// Not a reassignment — the server returns the asset unchanged, so the
		// screen does not ask for it.
		expect(
			nextAssignAction({
				customer: active,
				currentCustomerId: active.id,
				suspensionConfirmed: false,
			}),
		).toBe("blocked");
	});

	it("sends an active customer straight through", () => {
		expect(
			nextAssignAction({
				customer: active,
				currentCustomerId: null,
				suspensionConfirmed: false,
			}),
		).toBe("assign");
	});

	it("asks first for a suspended customer", () => {
		// Attaching one stops this asset's automated email entirely, so it is not
		// something to reach by mis-clicking a list.
		expect(
			nextAssignAction({
				customer: suspended,
				currentCustomerId: active.id,
				suspensionConfirmed: false,
			}),
		).toBe("confirm-suspended");
	});

	it("sends a suspended customer once the consequence is confirmed", () => {
		expect(
			nextAssignAction({
				customer: suspended,
				currentCustomerId: active.id,
				suspensionConfirmed: true,
			}),
		).toBe("assign");
	});

	it("still refuses the current customer even once confirmed", () => {
		// The confirmation is about suspension, not about overriding a no-op.
		expect(
			nextAssignAction({
				customer: suspended,
				currentCustomerId: suspended.id,
				suspensionConfirmed: true,
			}),
		).toBe("blocked");
	});
});
