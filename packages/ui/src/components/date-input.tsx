"use client";

import { Popover } from "@base-ui/react/popover";
import { Input } from "@bfa-platform/ui/components/input";
import {
	type DigitMask,
	digitsOf,
	maskedInputHandlers,
} from "@bfa-platform/ui/lib/digit-mask";
import { cn } from "@bfa-platform/ui/lib/utils";
import {
	isoToUsDate,
	normalizeUsDate,
	US_DATE_FORMAT,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
	type ComponentProps,
	type KeyboardEvent,
	useId,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";

/*
 * Calendar-day arithmetic on `YYYY-MM-DD` strings.
 *
 * Every step goes through UTC fields and nothing else, so a day is never pushed
 * through the reader's zone: the 1st cannot become the 31st west of UTC, and a
 * daylight-saving change cannot turn "add one day" into 23 or 25 hours.
 * `setUTCFullYear` rather than `Date.UTC`, because the latter reads years 0–99
 * as 1900–1999.
 */

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

const WEEKDAYS = [
	{ short: "Su", long: "Sunday" },
	{ short: "Mo", long: "Monday" },
	{ short: "Tu", long: "Tuesday" },
	{ short: "We", long: "Wednesday" },
	{ short: "Th", long: "Thursday" },
	{ short: "Fr", long: "Friday" },
	{ short: "Sa", long: "Saturday" },
] as const;

type CalendarDay = { year: number; month: number; day: number };

function parseIso(iso: string): CalendarDay {
	const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);

	return { year, month, day };
}

function toIso({ year, month, day }: CalendarDay) {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function utcDate(year: number, monthIndex: number, day: number) {
	const date = new Date(0);
	date.setUTCFullYear(year, monthIndex, day);

	return date;
}

function isoOfUtc(date: Date) {
	return toIso({
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
	});
}

function addDays(iso: string, amount: number) {
	const { year, month, day } = parseIso(iso);

	return isoOfUtc(utcDate(year, month - 1, day + amount));
}

function daysInMonth(year: number, month: number) {
	return utcDate(year, month, 0).getUTCDate();
}

/** Same day of the month, clamped: one month after 31 January is 28 or 29 February. */
function addMonths(iso: string, amount: number) {
	const { year, month, day } = parseIso(iso);
	const target = utcDate(year, month - 1 + amount, 1);
	const targetYear = target.getUTCFullYear();
	const targetMonth = target.getUTCMonth() + 1;

	return toIso({
		year: targetYear,
		month: targetMonth,
		day: Math.min(day, daysInMonth(targetYear, targetMonth)),
	});
}

function weekdayOf(iso: string) {
	const { year, month, day } = parseIso(iso);

	return utcDate(year, month - 1, day).getUTCDay();
}

/** The reader's own calendar day — the one moment a local clock is the right answer. */
function todayIso() {
	const now = new Date();

	return toIso({
		year: now.getFullYear(),
		month: now.getMonth() + 1,
		day: now.getDate(),
	});
}

/** The weeks of `iso`'s month, Sunday first, padded with the neighbouring months' days. */
function monthWeeks(iso: string) {
	const { year, month } = parseIso(iso);
	const first = toIso({ year, month, day: 1 });
	const start = addDays(first, -weekdayOf(first));
	const weekCount = Math.ceil(
		(weekdayOf(first) + daysInMonth(year, month)) / 7,
	);

	return Array.from({ length: weekCount }, (_, week) =>
		Array.from({ length: 7 }, (_, weekday) =>
			addDays(start, week * 7 + weekday),
		),
	);
}

/** What a screen reader announces for a day: "Wednesday, February 3, 2027". */
function dayLabel(iso: string) {
	const { year, month, day } = parseIso(iso);

	return `${WEEKDAYS[weekdayOf(iso)]?.long}, ${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

/*
 * The `MM/DD/YYYY` input mask, on the shared digit-mask editing model.
 *
 * The mask only shapes the text. It never checks or repairs the calendar:
 * `02/30/2026` is a perfectly well-formed entry here, and it is the field's
 * inline validation that says it is not a real day.
 */

/** A whole pasted or autofilled date with unpadded parts, e.g. `2/3/2027`. */
const LOOSE_US_DATE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{1,4})\s*$/;

/**
 * The digits an arbitrary piece of text contributes. A whole `M/D/YYYY` date
 * has its month and day padded first, so `2/3/2027` means 3 February rather
 * than the digits `232027`; the parts are padded, never corrected.
 */
function entryDigits(text: string) {
	const match = LOOSE_US_DATE.exec(text);

	if (!match) return digitsOf(text);

	const [, month = "", day = "", year = ""] = match;

	return `${month.padStart(2, "0")}${day.padStart(2, "0")}${year}`;
}

/**
 * `MM/DD/YYYY`: at most eight digits, a slash after the month and the day.
 * A pasted run longer than eight digits keeps the first eight.
 */
const DATE_MASK: DigitMask = {
	maxDigits: 8,
	overflow: "truncate",
	format(digits, trailingSeparator) {
		const kept = digits.slice(0, 8);
		let text = kept.slice(0, 2);

		if (kept.length > 2) text += `/${kept.slice(2, 4)}`;
		if (kept.length > 4) text += `/${kept.slice(4)}`;
		if (trailingSeparator && (kept.length === 2 || kept.length === 4)) {
			text += "/";
		}

		return text;
	},
};

/**
 * A calendar date field: masked `MM/DD/YYYY` entry plus a calendar picker.
 *
 * A text field rather than `<input type="date">`: the native control renders in
 * the browser's locale rather than the confirmed format, and its validity checks
 * surface as browser popups rather than the inline pattern. The value is the
 * text as displayed; convert with `usDateToIso` at the API boundary.
 *
 * The props not listed below go to the text input, so `useFormValidation`'s
 * `controlProps` (id, `aria-invalid`, `aria-describedby`, reveal-on-blur) wire
 * up exactly as they do on a plain `Input`, and a label's `htmlFor` names it.
 *
 * Typing is masked: only digits go in, the slashes appear after the month and
 * day, and the text stops at eight digits. Backspace, Delete, selection
 * replacement and paste edit the digits and keep the caret where the person was
 * working. Keystrokes and paste are handled directly; anything that bypasses
 * them (an IME, autofill, a programmatic change) goes through the same mask in
 * `onChange`. The mask shapes the text but never repairs a date — `02/30/2026`
 * stays as entered, for the field's error to explain. Choosing a day in the
 * picker writes the same exact spelling.
 */
function DateInput({
	value,
	onValueChange,
	onBlur,
	onKeyDown,
	onPaste,
	className,
	disabled,
	readOnly,
	pickerLabel = "Choose date",
	...props
}: Omit<ComponentProps<"input">, "type" | "value" | "onChange"> & {
	value: string;
	onValueChange: (value: string) => void;
	/** The accessible name of the calendar button and its dialog, e.g. "Choose annual test date". */
	pickerLabel?: string;
}) {
	const mask = maskedInputHandlers({
		mask: DATE_MASK,
		value,
		readOnly,
		onValueChange,
		onKeyDown,
		onPaste,
		pastedDigits: entryDigits,
		// Anything onChange sees is reduced to its digits and re-masked; surplus
		// digits beyond eight are dropped, as for paste.
		changedDigits: (raw) => entryDigits(raw),
	});

	return (
		<div data-slot="date-input" className="relative w-full">
			<Input
				type="text"
				inputMode="numeric"
				autoComplete="off"
				placeholder={US_DATE_FORMAT}
				{...props}
				disabled={disabled}
				readOnly={readOnly}
				value={value}
				className={cn("pr-9", className)}
				onKeyDown={mask.onKeyDown}
				onPaste={mask.onPaste}
				onChange={mask.onChange}
				onBlur={(event) => {
					const normalized = normalizeUsDate(event.currentTarget.value);
					if (normalized && normalized !== event.currentTarget.value) {
						onValueChange(normalized);
					}
					onBlur?.(event);
				}}
			/>
			<DatePicker
				value={value}
				label={pickerLabel}
				disabled={Boolean(disabled || readOnly)}
				onSelect={(iso) => onValueChange(isoToUsDate(iso))}
			/>
		</div>
	);
}

/**
 * The calendar button and its popup, following the WAI-ARIA date picker dialog
 * pattern.
 *
 * - The button opens a dialog named by `label`; focus moves to the selected day,
 *   or today when the field holds no valid date.
 * - The days are a grid with a roving tab stop. Arrow keys move by a day or a
 *   week, Home/End to the start or end of the week, Page Up/Page Down by a
 *   month (with Shift, a year). Enter or Space chooses the focused day.
 * - Escape, a click outside, or choosing a day closes the dialog and returns
 *   focus to the button. The month heading is a polite live region, so paging
 *   announces where the grid landed.
 */
function DatePicker({
	value,
	label,
	disabled,
	onSelect,
}: {
	value: string;
	label: string;
	disabled: boolean;
	onSelect: (iso: string) => void;
}) {
	const headingId = useId();
	const hintId = useId();
	const [open, setOpen] = useState(false);
	const [focusedDay, setFocusedDay] = useState(todayIso);
	const focusedDayRef = useRef<HTMLButtonElement>(null);

	const selectedDay = usDateToIso(value);
	const today = todayIso();
	const { year, month } = parseIso(focusedDay);

	function handleOpenChange(next: boolean) {
		// Seeded as it opens, from whatever the field holds at that moment, so the
		// grid starts where the typed date is rather than where it was last left.
		if (next) setFocusedDay(selectedDay ?? todayIso());
		setOpen(next);
	}

	function moveFocus(next: string) {
		// Flushed so the day being moved to exists — possibly in a different
		// month's grid — before focus is put on it.
		flushSync(() => setFocusedDay(next));
		focusedDayRef.current?.focus();
	}

	function handleGridKeyDown(event: KeyboardEvent<HTMLTableElement>) {
		const weekday = weekdayOf(focusedDay);
		const yearStep = event.shiftKey ? 12 : 1;
		const next: Record<string, string> = {
			ArrowLeft: addDays(focusedDay, -1),
			ArrowRight: addDays(focusedDay, 1),
			ArrowUp: addDays(focusedDay, -7),
			ArrowDown: addDays(focusedDay, 7),
			Home: addDays(focusedDay, -weekday),
			End: addDays(focusedDay, 6 - weekday),
			PageUp: addMonths(focusedDay, -yearStep),
			PageDown: addMonths(focusedDay, yearStep),
		};
		const target = next[event.key];

		if (!target) return;

		event.preventDefault();
		moveFocus(target);
	}

	return (
		<Popover.Root open={open} onOpenChange={handleOpenChange}>
			<Popover.Trigger
				data-slot="date-input-trigger"
				disabled={disabled}
				aria-label={label}
				className={cn(
					"absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
					"hover:bg-accent hover:text-accent-foreground",
					"focus-visible:ring-2 focus-visible:ring-ring/40",
					"disabled:pointer-events-none disabled:opacity-60",
				)}
			>
				<CalendarDays className="size-4" aria-hidden="true" />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					className="isolate z-50 outline-none"
					side="bottom"
					align="end"
					sideOffset={4}
				>
					<Popover.Popup
						data-slot="date-input-calendar"
						role="dialog"
						aria-label={label}
						initialFocus={focusedDayRef}
						className="z-50 w-max rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-card)] outline-none"
					>
						<div className="flex items-center justify-between gap-2 pb-2">
							<button
								type="button"
								aria-label="Previous month"
								onClick={() => setFocusedDay(addMonths(focusedDay, -1))}
								className={NAV_BUTTON_CLASS}
							>
								<ChevronLeft className="size-4" aria-hidden="true" />
							</button>
							<p
								id={headingId}
								aria-live="polite"
								className="font-semibold text-[13px] text-foreground"
							>
								{MONTH_NAMES[month - 1]} {year}
							</p>
							<button
								type="button"
								aria-label="Next month"
								onClick={() => setFocusedDay(addMonths(focusedDay, 1))}
								className={NAV_BUTTON_CLASS}
							>
								<ChevronRight className="size-4" aria-hidden="true" />
							</button>
						</div>

						<table
							// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the WAI-ARIA date picker dialog pattern makes the month table a grid; the roving tab stop and arrow keys below are what that role promises
							role="grid"
							aria-labelledby={headingId}
							aria-describedby={hintId}
							onKeyDown={handleGridKeyDown}
							className="border-collapse"
						>
							<thead>
								<tr>
									{WEEKDAYS.map((weekday) => (
										<th
											key={weekday.long}
											scope="col"
											abbr={weekday.long}
											className="size-8 font-medium text-[11px] text-muted-foreground"
										>
											{weekday.short}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{monthWeeks(focusedDay).map((week) => (
									<tr key={week[0]}>
										{week.map((day) => {
											const isFocused = day === focusedDay;
											const isSelected = day === selectedDay;
											const inMonth = parseIso(day).month === month;

											return (
												// biome-ignore lint/a11y/useFocusableInteractive: in the WAI-ARIA grid pattern the focus stop is the day button inside the cell, not the cell itself
												<td
													key={day}
													// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: each day cell of the date picker grid is a gridcell carrying the selection state, with a real button inside it
													role="gridcell"
													aria-selected={isSelected}
													className="p-0 text-center"
												>
													<button
														ref={isFocused ? focusedDayRef : undefined}
														type="button"
														tabIndex={isFocused ? 0 : -1}
														aria-label={dayLabel(day)}
														aria-current={day === today ? "date" : undefined}
														onClick={() => {
															onSelect(day);
															setOpen(false);
														}}
														className={cn(
															"flex size-8 items-center justify-center rounded-md text-[13px] tabular-nums outline-none transition-colors",
															"hover:bg-accent hover:text-accent-foreground",
															"focus-visible:ring-2 focus-visible:ring-ring/40",
															inMonth
																? "text-foreground"
																: "text-text-tertiary",
															day === today && "font-semibold text-primary",
															isSelected &&
																"bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
														)}
													>
														{parseIso(day).day}
													</button>
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>

						<p
							id={hintId}
							className="max-w-[224px] pt-2 text-[11px] text-muted-foreground"
						>
							Arrow keys move between days. Page Up and Page Down change the
							month.
						</p>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

const NAV_BUTTON_CLASS = cn(
	"flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
	"hover:bg-accent hover:text-accent-foreground",
	"focus-visible:ring-2 focus-visible:ring-ring/40",
);

export { DateInput };
