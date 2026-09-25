"use client";

import { Input } from "@bfa-platform/ui/components/input";
import type * as React from "react";

/**
 * A number field with its unit inside it, on the right ("60 PSI"), so nobody
 * has to guess what a bare "3.2" is. The suffix is a label over the input's
 * padding, not part of its value, and lets clicks through to the field.
 */
/** Digits and at most one decimal point — anything else typed or pasted is dropped. */
function numericOnly(text: string): string {
	const [whole = "", ...rest] = text.replace(/[^0-9.]/g, "").split(".");

	return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

export function UnitInput({
	unit,
	onChange,
	...props
}: Omit<React.ComponentProps<typeof Input>, "type"> & { unit: string }) {
	return (
		<div className="relative">
			<Input
				inputMode="decimal"
				className="pr-14"
				{...props}
				onChange={(event) => {
					event.target.value = numericOnly(event.target.value);
					onChange?.(event);
				}}
			/>
			<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-semibold text-[13px] text-muted-foreground">
				{unit}
			</span>
		</div>
	);
}
