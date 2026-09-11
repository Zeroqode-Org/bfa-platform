/**
 * Reading a submission's `overridden_fields` marker.
 *
 * A module of its own, importing nothing, for the same reason
 * `asset-field-limits.ts` is one: the WP's document view is a client component
 * and needs this on every field it renders, and a helper that lived beside the
 * Zod shapes would pull Zod into the browser bundle to answer a question that
 * is pure string handling.
 *
 * What the marker is for: the existing-BIN wizard flow prefills the
 * questionnaire from the asset's prior submission and lets the certifier
 * overwrite any value. The PRD is explicit that those overwrites must be
 * "visibly flagged to the WP, not silently replaced" (§ 9), because the final
 * value alone does not say whether somebody typed over a known-good reading.
 * `overridden_fields` is the record of which ones they were.
 */

/**
 * The field names a marker names, as a set the document view can ask about one
 * field at a time.
 *
 * The column is `jsonb` with no shape promised by the schema — the wizard that
 * writes it is § 6.5, week 4 — so this reads the two spellings worth reading
 * and treats anything else as "nothing flagged": an array of names, which is
 * the natural encoding, and an object keyed by name, which is what a
 * `{ field: previousValue }` map looks like.
 *
 * Anything else returns empty rather than throwing. A marker nobody can parse
 * must not be able to stop a WP opening the record it is attached to — the
 * failure mode of a decorative flag is a missing flag, and the failure mode of
 * a throw here is an unreadable test.
 */
export function overriddenFieldNames(value: unknown): Set<string> {
	if (Array.isArray(value)) {
		return new Set(value.filter((name) => typeof name === "string"));
	}

	if (typeof value === "object" && value !== null) {
		return new Set(Object.keys(value));
	}

	return new Set();
}

/**
 * What the flag says when a reader hovers or reads it out.
 *
 * One sentence, defined once, because the table and the document view both show
 * it and two wordings would be two different claims about the same marker.
 */
export const OVERRIDDEN_FIELD_NOTE =
	"The certifier typed over the value prefilled from this assembly's last test.";
