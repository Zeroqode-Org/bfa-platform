"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { DialogFooter } from "@bfa-platform/ui/components/dialog";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bfa-platform/ui/components/select";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import type {
	RepairCompany,
	RepairCompanyPayload,
} from "./repair-company-types";
import { DEACTIVATION_WARNING } from "./repair-company-types";

export const STATUS_LABELS = {
	active: "Active",
	inactive: "Inactive",
} as const;

/**
 * What the form holds while it is being typed into. Every field is a string,
 * including the status enum, because that is what an input hands back — the
 * conversion to the procedure's shape happens once, in
 * `buildRepairCompanyPayload`.
 */
export type RepairCompanyFormValues = {
	companyName: string;
	phone: string;
	email: string;
	status: RepairCompany["status"];
};

export const emptyRepairCompanyValues: RepairCompanyFormValues = {
	companyName: "",
	phone: "",
	email: "",
	status: "active",
};

/** An existing row as form values. Nullable columns become empty strings. */
export function repairCompanyToFormValues(
	company: RepairCompany,
): RepairCompanyFormValues {
	return {
		companyName: company.companyName,
		phone: company.phone ?? "",
		email: company.email ?? "",
		status: company.status,
	};
}

/**
 * Form values as the procedure's input.
 *
 * Both contact fields are optional, and a field that was typed into and cleared
 * hands back `""`. That collapses to `null` here as well as on the server, so
 * the request says "no phone" rather than "a phone that is the empty string" —
 * and there is no `waterPurveyorId` to send, because the tenant is the server's
 * to decide from the caller's own profile.
 */
export function buildRepairCompanyPayload(
	values: RepairCompanyFormValues,
): RepairCompanyPayload {
	return {
		companyName: values.companyName.trim(),
		phone: values.phone.trim() || null,
		email: values.email.trim() || null,
		status: values.status,
	};
}

/**
 * Create and edit are the same form — the only differences are the starting
 * values and the button label, and splitting them would leave two copies of the
 * optional-field rule to keep in step.
 *
 * Split out from its dialog so the submit behaviour can be exercised without
 * driving a modal's portal and focus trap, the same way `CustomerForm` is.
 */
export function RepairCompanyForm({
	initialValues = emptyRepairCompanyValues,
	pending = false,
	errorMessage,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
}: {
	initialValues?: RepairCompanyFormValues;
	pending?: boolean;
	errorMessage?: string;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (payload: RepairCompanyPayload) => void;
	onCancel: () => void;
}) {
	const companyNameId = useId();
	const phoneId = useId();
	const emailId = useId();
	const statusId = useId();

	const [values, setValues] = useState<RepairCompanyFormValues>(initialValues);

	function update<Field extends keyof RepairCompanyFormValues>(
		field: Field,
		value: RepairCompanyFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onSubmit(buildRepairCompanyPayload(values));
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={companyNameId}>Company name</Label>
				<Input
					id={companyNameId}
					name="companyName"
					value={values.companyName}
					onChange={(event) => update("companyName", event.target.value)}
					placeholder="Ridgeline Backflow Repair"
					autoComplete="off"
					disabled={pending}
					required
				/>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={phoneId}>Phone</Label>
					<Input
						id={phoneId}
						name="phone"
						type="tel"
						value={values.phone}
						onChange={(event) => update("phone", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						disabled={pending}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={emailId}>Email</Label>
					<Input
						id={emailId}
						name="email"
						type="email"
						value={values.email}
						onChange={(event) => update("email", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						disabled={pending}
					/>
				</div>
			</div>

			{/* Neither contact field is required on its own, but a company the
			    customer cannot reach is not much use in a failure notice. */}
			<p className="text-[12px] text-muted-foreground">
				Phone and email are optional — whichever you fill in is what the failure
				notice shows.
			</p>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={statusId}>Status</Label>
				<Select
					items={STATUS_LABELS}
					value={values.status}
					onValueChange={(value) =>
						update("status", value as RepairCompany["status"])
					}
					disabled={pending}
				>
					<SelectTrigger id={statusId} name="status">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value="active">{STATUS_LABELS.active}</SelectItem>
							<SelectItem value="inactive">{STATUS_LABELS.inactive}</SelectItem>
						</SelectGroup>
					</SelectContent>
				</Select>
			</div>

			{/* Status is the one field here with a consequence outside this form, so
			    it says so at the moment it is chosen — not after saving. */}
			{values.status === "inactive" ? (
				<p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning">
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{DEACTIVATION_WARNING}
				</p>
			) : null}

			{errorMessage ? (
				<p
					role="alert"
					className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{errorMessage}
				</p>
			) : null}

			<DialogFooter>
				<Button
					type="button"
					variant="secondary"
					onClick={onCancel}
					disabled={pending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={pending}>
					{pending ? pendingLabel : submitLabel}
				</Button>
			</DialogFooter>
		</form>
	);
}
