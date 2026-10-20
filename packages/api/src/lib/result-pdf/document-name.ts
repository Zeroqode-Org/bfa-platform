/**
 * What a result document is called, to a person: the file name in the tab and
 * on disk, and the title inside the PDF.
 *
 * Built from the things a certifier or a clerk recognises a test by — the
 * assembly's BIN, its type and the test date — instead of the submission's
 * UUID, so `Backflow-Test_SEED-BIN-200_DC_2026-09-25.pdf` is what shows up in
 * a downloads folder.
 */

/** Keeps a file-name part to characters every file system and storage key accepts. */
function safe(part: string): string {
	return part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resultDocumentFileName({
	bin,
	bfaType,
	testDate,
}: {
	bin: string | null;
	bfaType: string;
	testDate: string | null;
}): string {
	const parts = [
		"Backflow-Test",
		safe(bin ?? "") || "No-BIN",
		safe(bfaType),
		safe(testDate ?? "") || "undated",
	];

	return `${parts.join("_")}.pdf`;
}

/** The PDF's own title — shown by viewers in their title bar and tab. */
export function resultDocumentTitle({
	bin,
	bfaType,
	testDate,
}: {
	bin: string | null;
	bfaType: string;
	testDate: string | null;
}): string {
	const [year, month, day] = (testDate ?? "").split("-");
	const date = year && month && day ? `${month}/${day}/${year}` : "undated";

	return `Backflow Reporter.io Test Form — ${bin ?? "No BIN"} — ${bfaType} — ${date}`;
}
