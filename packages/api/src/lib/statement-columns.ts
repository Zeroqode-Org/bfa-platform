/**
 * The monthly statement's CSV: which columns it carries, in what order, and how
 * each cell is written (PRD § 6.12, build plan "Monthly statements export").
 *
 * Pure on purpose — no database, no tRPC — so the file format can be tested on
 * its own, and the route that serves it is only plumbing.
 */

/** One submitted test, as the export procedure selects it. */
export type StatementRow = {
	customerName: string | null;
	bin: string | null;
	submittedBinText: string | null;
	serviceAddress: string | null;
	bfaType: string;
	testDate: string | null;
	testResult: "pass" | "fail" | null;
	certifierName: string | null;
};

const RESULT_LABELS = { pass: "Pass", fail: "Fail" } as const;

/**
 * The column set, in order. The one place a field is added: the header row and
 * every data row are both read from this list, so they cannot fall out of step.
 *
 * `BIN` falls back to what the certifier typed when the submission never
 * resolved to an asset — the same rule the Submitted Tests table applies — so
 * an unresolved test is in the statement rather than a blank line.
 */
export const STATEMENT_COLUMNS: {
	header: string;
	value: (row: StatementRow) => string | null;
}[] = [
	{ header: "BIN", value: (row) => row.bin ?? row.submittedBinText },
	{ header: "Customer name", value: (row) => row.customerName },
	{ header: "Service address", value: (row) => row.serviceAddress },
	{ header: "BFA type", value: (row) => row.bfaType },
	{ header: "Test date", value: (row) => usCalendarDate(row.testDate) },
	{
		header: "Result",
		value: (row) => (row.testResult ? RESULT_LABELS[row.testResult] : null),
	},
	{ header: "Certifier", value: (row) => row.certifierName },
];

/**
 * `YYYY-MM-DD` as `MM/DD/YYYY` — what a US spreadsheet reads as a date, and the
 * format the rest of the WP screens type dates in. String surgery rather than
 * `Date`, because `test_date` is a calendar day with no zone to shift it.
 */
function usCalendarDate(value: string | null): string | null {
	if (!value) return null;

	const [year, month, day] = value.split("-");

	return `${month}/${day}/${year}`;
}

/**
 * A cell a spreadsheet would run as a formula (CSV injection). Every value in
 * this file is typed by a person — customer names, addresses, a certifier's
 * BIN text — and a leading `=`, `+`, `-`, `@`, tab or carriage return is
 * executed on open by Excel and friends. Such a cell is prefixed with `'`,
 * which the spreadsheet treats as "this is text" and does not display.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function csvCell(value: string | null): string {
	if (value === null || value === "") return "";

	const safe = FORMULA_TRIGGER.test(value) ? `'${value}` : value;

	// RFC 4180: a cell holding a delimiter, a quote or a line break is quoted,
	// with its own quotes doubled.
	return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The whole file. Starts with a UTF-8 byte-order mark so Excel opens a name
 * like "Kaʻahumanu" as written rather than as mojibake, and uses CRLF line
 * endings as RFC 4180 specifies.
 */
export function statementCsv(rows: StatementRow[]): string {
	const lines = [
		STATEMENT_COLUMNS.map((column) => csvCell(column.header)).join(","),
		...rows.map((row) =>
			STATEMENT_COLUMNS.map((column) => csvCell(column.value(row))).join(","),
		),
	];

	return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * The download's file name: `submitted-tests_<from>_<to>.csv`, with `all` for
 * an open bound, so two statements saved side by side say which period each
 * one covers.
 */
export function statementFileName(range: { from?: string; to?: string }) {
	return `submitted-tests_${range.from ?? "all"}_${range.to ?? "all"}.csv`;
}
