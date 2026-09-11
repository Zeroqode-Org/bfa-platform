import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

import {
	CallerRefusedError,
	callerRefusal,
	refusalErrorData,
} from "./caller-refusal";

/**
 * The refusal vocabulary, on its own — no database, no tRPC runtime.
 *
 * `refusalErrorData` is what the error formatter puts on the wire, and it is
 * the only thing telling the browser apart "you are blocked, go to the sign-in
 * screen" from "you may not do that here, stay where you are". Both are
 * `FORBIDDEN`.
 */

describe("callerRefusal", () => {
	it("reads the reason off a refusal", () => {
		expect(
			callerRefusal(new CallerRefusedError("blocked", "Account blocked")),
		).toBe("blocked");
		expect(
			callerRefusal(new CallerRefusedError("no_profile", "No profile")),
		).toBe("no_profile");
	});

	it("answers null for every other error", () => {
		// An ordinary permission error is also a FORBIDDEN, and must not be
		// mistaken for a blocked account.
		expect(
			callerRefusal(
				new TRPCError({ code: "FORBIDDEN", message: "Water Purveyor only" }),
			),
		).toBeNull();
		expect(callerRefusal(new Error("connection reset"))).toBeNull();
		expect(callerRefusal(null)).toBeNull();
		expect(callerRefusal(undefined)).toBeNull();
		expect(callerRefusal("blocked")).toBeNull();
		// A plain object wearing the right shape is not a refusal.
		expect(callerRefusal({ refusal: "blocked" })).toBeNull();
	});
});

describe("refusalErrorData", () => {
	it("carries the reason as a value for the wire", () => {
		expect(
			refusalErrorData(new CallerRefusedError("blocked", "Account blocked")),
		).toEqual({ refusal: "blocked" });
	});

	it("finds a refusal that tRPC wrapped rather than rethrew", () => {
		// A `TRPCError` thrown from a procedure arrives unwrapped, but anything
		// reaching tRPC by another route is wrapped with the original on `cause`.
		const wrapped = new TRPCError({
			code: "FORBIDDEN",
			message: "Account blocked",
			cause: new CallerRefusedError("blocked", "Account blocked"),
		});

		expect(refusalErrorData(wrapped)).toEqual({ refusal: "blocked" });
	});

	it("adds nothing to an ordinary error", () => {
		expect(
			refusalErrorData(
				new TRPCError({ code: "FORBIDDEN", message: "Water Purveyor only" }),
			),
		).toBeNull();
		expect(refusalErrorData(new Error("nope"))).toBeNull();
		expect(refusalErrorData(null)).toBeNull();
	});

	it("stays a TRPCError, so procedures keep returning a proper code", () => {
		const refusal = new CallerRefusedError("blocked", "Account blocked");

		expect(refusal).toBeInstanceOf(TRPCError);
		expect(refusal.code).toBe("FORBIDDEN");
	});
});
