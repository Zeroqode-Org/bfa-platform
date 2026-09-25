"use client";

import { cn } from "@bfa-platform/ui/lib/utils";

type Choice<Value extends string> = { value: Value; label: string };

/**
 * A row of large tap targets for a short closed answer. Certifiers fill this
 * in on a phone, on site, often in gloves — a 44px button is a far easier hit
 * than a dropdown's small trigger and its popup, and every option stays
 * visible without opening anything.
 */
function ChoiceButtons<Value extends string>({
	label,
	choices,
	value,
	onValueChange,
}: {
	/** The question, for assistive tech — the visible label sits above the group. */
	label: string;
	choices: Choice<Value>[];
	value: Value | null | undefined;
	onValueChange: (value: Value) => void;
}) {
	return (
		<fieldset
			aria-label={label}
			className={cn(
				"m-0 grid min-w-0 gap-2 border-0 p-0",
				// Three choices share a row only where "Undetermined" fits; on a
				// narrow phone it drops to a row of its own instead of overflowing.
				choices.length === 3
					? "grid-cols-2 min-[420px]:grid-cols-3"
					: "grid-cols-2",
			)}
		>
			{choices.map((choice, index) => {
				const selected = choice.value === value;

				return (
					<button
						key={choice.value}
						type="button"
						aria-pressed={selected}
						onClick={() => onValueChange(choice.value)}
						className={cn(
							"h-11 min-w-0 rounded-md border px-3 font-semibold text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
							choices.length === 3 &&
								index === 2 &&
								"col-span-2 min-[420px]:col-span-1",
							selected
								? "border-primary bg-accent text-primary"
								: "border-input bg-card text-foreground hover:bg-muted",
						)}
					>
						{choice.label}
					</button>
				);
			})}
		</fieldset>
	);
}

/** A Yes/No answer, stored as a real boolean in `wizard_data` — never the strings "yes"/"no". */
export function YesNoButtons({
	label,
	value,
	onValueChange,
}: {
	label: string;
	value: boolean | null | undefined;
	onValueChange: (value: boolean) => void;
}) {
	return (
		<ChoiceButtons
			label={label}
			choices={[
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			]}
			value={value === true ? "yes" : value === false ? "no" : undefined}
			onValueChange={(next) => onValueChange(next === "yes")}
		/>
	);
}

/** The Initial Test answer — also the submission's overall result. */
export function PassFailButtons({
	label,
	value,
	onValueChange,
}: {
	label: string;
	value: string | null | undefined;
	onValueChange: (value: "pass" | "fail") => void;
}) {
	return (
		<ChoiceButtons
			label={label}
			choices={[
				{ value: "pass", label: "Pass" },
				{ value: "fail", label: "Fail" },
			]}
			value={value as "pass" | "fail" | undefined}
			onValueChange={onValueChange}
		/>
	);
}

/** "Does this assembly isolate the entire property?" */
export function IsolatesButtons({
	label,
	value,
	onValueChange,
}: {
	label: string;
	value: string | null | undefined;
	onValueChange: (value: "yes" | "no" | "undetermined") => void;
}) {
	return (
		<ChoiceButtons
			label={label}
			choices={[
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
				{ value: "undetermined", label: "Undetermined" },
			]}
			value={value as "yes" | "no" | "undetermined" | undefined}
			onValueChange={onValueChange}
		/>
	);
}

/** How the closing block was signed: the owner signs on the phone, or the certifier records that the owner was not present. */
export function SignOffButtons({
	label,
	value,
	onValueChange,
}: {
	label: string;
	value: "signed" | "owner_absent" | "" | null | undefined;
	onValueChange: (value: "signed" | "owner_absent") => void;
}) {
	return (
		<ChoiceButtons
			label={label}
			choices={[
				{ value: "signed", label: "Signature" },
				{ value: "owner_absent", label: "Owner not present" },
			]}
			value={value || undefined}
			onValueChange={onValueChange}
		/>
	);
}
