import { describe, expect, it } from "vitest";

import { passwordPolicyError } from "./password-policy";

describe("passwordPolicyError", () => {
	it("accepts eight characters with a capital and a special character", () => {
		expect(passwordPolicyError("Backflow!")).toBeUndefined();
		expect(passwordPolicyError("Abcdef_1")).toBeUndefined();
	});

	it("asks for length first", () => {
		expect(passwordPolicyError("Ab!")).toBe("Use at least 8 characters.");
	});

	it("asks for a capital letter", () => {
		expect(passwordPolicyError("backflow!")).toBe(
			"Include at least one capital letter.",
		);
	});

	it("asks for a special character", () => {
		expect(passwordPolicyError("Backflow1")).toMatch(/special character/);
	});

	// A space is easy to type by accident and is not what anyone means by a
	// special character.
	it("does not count whitespace as the special character", () => {
		expect(passwordPolicyError("Back flow")).toMatch(/special character/);
	});
});
