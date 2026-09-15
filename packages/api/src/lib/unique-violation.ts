/** Postgres' `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether a thrown error is Postgres refusing a duplicate row — optionally, one
 * refused by a specific unique constraint or index.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` carrying the statement,
 * so the `code` and `constraint` the `pg` driver set are one `cause` down rather
 * than on the error in hand. The chain is walked instead of reaching for
 * `.cause.code` directly, so another wrapping layer does not silently turn a
 * duplicate back into a 500.
 *
 * Naming the constraint matters wherever a table has more than one unique rule:
 * only the violation that belongs to a field may be reported at that field.
 */
export function isUniqueViolation(error: unknown, constraint?: string) {
	for (
		let current: unknown = error, depth = 0;
		current && depth < 5;
		current = (current as { cause?: unknown }).cause, depth++
	) {
		const candidate = current as { code?: unknown; constraint?: unknown };

		if (candidate.code === UNIQUE_VIOLATION) {
			return constraint === undefined || candidate.constraint === constraint;
		}
	}

	return false;
}
