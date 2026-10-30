import { describe, expect, it } from "vitest";

import { passwordPolicyError } from "./password-policy";

describe("passwordPolicyError", () => {
	it("accepts eight characters with a lowercase, a capital, a number and a symbol", () => {
		expect(passwordPolicyError("Backflow1!")).toBeUndefined();
		expect(passwordPolicyError("Abcdef_1")).toBeUndefined();
	});

	it("asks for length first", () => {
		expect(passwordPolicyError("Ab1!")).toBe("Use at least 8 characters.");
	});

	it("asks for a lowercase letter", () => {
		expect(passwordPolicyError("BACKFLOW1!")).toBe(
			"Include at least one lowercase letter.",
		);
	});

	it("asks for a capital letter", () => {
		expect(passwordPolicyError("backflow1!")).toBe(
			"Include at least one capital letter.",
		);
	});

	it("asks for a number", () => {
		expect(passwordPolicyError("Backflow!")).toBe(
			"Include at least one number.",
		);
	});

	it("asks for a symbol", () => {
		expect(passwordPolicyError("Backflow1")).toMatch(/symbol/);
	});

	// Supabase Auth counts only its own ASCII symbol set, so a space or `€`
	// passing here would be refused there with an error of its own.
	it("counts only the symbols Supabase Auth counts", () => {
		expect(passwordPolicyError("Back flow1")).toMatch(/symbol/);
		expect(passwordPolicyError("Backflow1€")).toMatch(/symbol/);
		for (const symbol of ["~", "`", "\\", '"', "[", "]", "-"]) {
			expect(passwordPolicyError(`Backflow1${symbol}`)).toBeUndefined();
		}
	});
});
