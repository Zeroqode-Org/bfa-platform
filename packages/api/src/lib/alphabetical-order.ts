import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * Orders a text column alphabetically: case-insensitive, digits before
 * letters, the same on every database.
 *
 * Plain `order by name` follows the database's collation, which varies by
 * server and can rank capitals apart from lowercase. Lower-casing and then
 * comparing in the "C" collation compares character codes, so "1A1A Backflow
 * Testing" and "808 Plumbing" come before "A-1 Plumbing", then "Commercial
 * Plumbing", then "Zen Backflow Testers" — the order the client asked for on
 * the lists sent to customers (WP/Admin feedback).
 */
export function alphabetically(column: AnyColumn): SQL {
	return sql`lower(${column}) collate "C"`;
}
