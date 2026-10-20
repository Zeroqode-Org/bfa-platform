/**
 * The annual test date an edit form was opened with, and what happens when the
 * stored date has moved since.
 *
 * The asset form submits the whole record, the date included, and the date is
 * not only the WP's to move: a passing test moves it to the next cycle
 * (`advanceAnnualTestDate`). Without a check, a form opened before that pass
 * would put the old date back on save — the asset past due again, and the
 * escalation queued against an assembly that just passed.
 *
 * So `updateAsset` takes the date the form was opened with. A form that left
 * the date as it found it keeps whatever is stored now, and the rest of the
 * edit goes through. A form that changed the date while it also moved
 * underneath is refused: two different answers to "when is this due", and the
 * person should see the current one before choosing.
 *
 * Import-free on purpose, like `customer-revision.ts`: the web app tells this
 * `CONFLICT` apart from the duplicate-BIN one by comparing the message, and it
 * must be able to do that without pulling a router into the browser bundle.
 */

export const ASSET_STALE_DATE_MESSAGE =
	"This asset's annual test date changed after you opened this form — a passing test may have moved it. Close it, reopen the asset, and apply your change again.";

/** Whether a failed mutation is the moved-date conflict rather than a duplicate BIN. */
export function isStaleAssetDateError(error: {
	message: string;
	data?: { code?: string | null } | null;
}): boolean {
	return (
		error.data?.code === "CONFLICT" &&
		error.message === ASSET_STALE_DATE_MESSAGE
	);
}

/**
 * The annual test date a save should write, given what is stored now.
 *
 * `undefined` for `opened` means the caller sent no expectation — the date in
 * the input is written as it is. `{ ok: false }` is the moved-date conflict;
 * the caller raises it.
 */
export function resolveAnnualTestDate({
	stored,
	opened,
	submitted,
}: {
	stored: string | null;
	opened: string | null | undefined;
	submitted: string;
}): { ok: true; date: string } | { ok: false } {
	if (opened === undefined || opened === stored) {
		return { ok: true, date: submitted };
	}

	// Moved underneath. Untouched on the form: keep the stored date.
	if (submitted === opened) {
		return stored ? { ok: true, date: stored } : { ok: true, date: submitted };
	}

	// Changed on the form to what is now stored anyway — no disagreement.
	if (submitted === stored) return { ok: true, date: submitted };

	return { ok: false };
}
