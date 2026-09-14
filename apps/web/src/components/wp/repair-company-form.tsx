"use client";

import { REPAIR_COMPANY_FIELD_LIMITS } from "@bfa-platform/api/lib/repair-company-field-limits";
import { Button } from "@bfa-platform/ui/components/button";
import { DialogBody, DialogFooter } from "@bfa-platform/ui/components/dialog";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { PhoneInput } from "@bfa-platform/ui/components/phone-input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bfa-platform/ui/components/select";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	email,
	formatUsPhone,
	maxLength,
	required,
	usPhone,
} from "@bfa-platform/ui/lib/validation";
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
 *
 * A valid phone number is sent in its one display spelling, `(XXX) XXX-XXXX`,
 * whether or not the field was blurred first. Anything else is sent as typed:
 * the form refuses to submit it, and nothing here is allowed to quietly rewrite
 * a number that is not one.
 */
export function buildRepairCompanyPayload(
	values: RepairCompanyFormValues,
): RepairCompanyPayload {
	return {
		companyName: values.companyName.trim(),
		phone: formatUsPhone(values.phone) ?? (values.phone.trim() || null),
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
	const statusId = useId();

	const [values, setValues] = useState<RepairCompanyFormValues>(initialValues);

	// The server's rules, checked here first so the person hears about them at
	// the field. Phone and email stay independently optional: a blank one passes
	// its rule, and only a filled-in one has to be a real number or address.
	const validation = useFormValidation({
		values,
		rules: {
			companyName: composeRules(
				required("Company name is required."),
				maxLength(REPAIR_COMPANY_FIELD_LIMITS.companyName),
			),
			phone: usPhone(),
			email: composeRules(
				email(),
				maxLength(REPAIR_COMPANY_FIELD_LIMITS.email),
			),
		},
	});

	function update<Field extends keyof RepairCompanyFormValues>(
		field: Field,
		value: RepairCompanyFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!validation.validate()) return;

		onSubmit(buildRepairCompanyPayload(values));
	}

	return (
		<form
			onSubmit={handleSubmit}
			// A column that takes exactly the height its dialog hands it. Only
			// `DialogBody` scrolls, so the footer stays on screen on a short
			// viewport instead of being pushed off the bottom of it.
			className="flex min-h-0 flex-1 flex-col gap-4"
			noValidate
		>
			<DialogBody>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("companyName")}>
						Company name
					</Label>
					<Input
						{...validation.controlProps("companyName")}
						name="companyName"
						value={values.companyName}
						onChange={(event) => update("companyName", event.target.value)}
						placeholder="Ridgeline Backflow Repair"
						autoComplete="off"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("companyName")} />
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("phone")}>Phone</Label>
						<PhoneInput
							{...validation.controlProps("phone")}
							name="phone"
							value={values.phone}
							onValueChange={(value) => update("phone", value)}
							placeholder="Optional — (555) 123-4567"
							autoComplete="off"
							disabled={pending}
						/>
						<FieldError {...validation.errorProps("phone")} />
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("email")}>Email</Label>
						<Input
							{...validation.controlProps("email")}
							name="email"
							type="email"
							value={values.email}
							onChange={(event) => update("email", event.target.value)}
							placeholder="Optional"
							autoComplete="off"
							disabled={pending}
						/>
						<FieldError {...validation.errorProps("email")} />
					</div>
				</div>

				{/* Neither contact field is required on its own, but a company the
				    customer cannot reach is not much use in a failure notice. */}
				<p className="text-[12px] text-muted-foreground">
					Phone and email are optional — whichever you fill in is what the
					failure notice shows.
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
								<SelectItem value="inactive">
									{STATUS_LABELS.inactive}
								</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>

				{/* Status is the one field here with a consequence outside this form, so
				    it says so at the moment it is chosen — not after saving. */}
				{values.status === "inactive" ? (
					<p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning">
						<TriangleAlert
							className="mt-px size-4 shrink-0"
							aria-hidden="true"
						/>
						{DEACTIVATION_WARNING}
					</p>
				) : null}

				<FormError message={errorMessage} />
			</DialogBody>
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
