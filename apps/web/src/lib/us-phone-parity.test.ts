import { normalizeUsPhone } from "@bfa-platform/api/lib/us-phone";
import { formatUsPhone } from "@bfa-platform/ui/lib/validation";
import { describe, expect, it } from "vitest";

/**
 * The repair-company phone rule exists twice: in the input schema, which is the
 * boundary, and in the form, which reports a problem before the request is made.
 * The two live in packages that do not depend on each other, so this is where
 * they are held to the same answer — a number the form accepts must be stored,
 * and one it refuses must be refused, in the same canonical spelling.
 */

const CASES = [
	"(555) 123-4567",
	"555-123-4567",
	"5551234567",
	"555.123.4567",
	"  555 123 4567 ",
	"+1 555 123 4567",
	"+15551234567",
	"1-555-123-4567",
	"555-0142",
	"555123456",
	"55512345678",
	"+2 555 123 4567",
	"555-CALL-NOW",
	"555-123-4567 x12",
	"++1 555 123 4567",
	"555_123_4567",
	"",
];

describe("US phone rule parity", () => {
	it.each(CASES)("server and form agree on %j", (value) => {
		expect(formatUsPhone(value)).toBe(normalizeUsPhone(value));
	});
});
