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
	SELECT_PLACEHOLDER,
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
import { useState } from "react";

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
 *
 * The status may be `""`: a new company opens with it unanswered, so "active"
 * is a choice somebody made rather than a default nobody looked at.
 */
export type RepairCompanyFormValues = {
	companyName: string;
	phone: string;
	email: string;
	status: RepairCompany["status"] | "";
};

/** Form values in which the status holds a real choice — the only kind that is sent. */
export type CompletedRepairCompanyFormValues = RepairCompanyFormValues & {
	status: RepairCompany["status"];
};

export const emptyRepairCompanyValues: RepairCompanyFormValues = {
	companyName: "",
	phone: "",
	email: "",
	status: "",
};

/** An existing row as form values. Nullable columns become empty strings. */
export function repairCompanyToFormValues(
	company: RepairCompany,
): CompletedRepairCompanyFormValues {
	return {
		companyName: company.companyName,
		phone: company.phone ?? "",
		email: company.email ?? "",
		status: company.status,
	};
}

/** Whether the status has been answered, so the values may become a payload. */
export function isCompletedRepairCompany(
	values: RepairCompanyFormValues,
): values is CompletedRepairCompanyFormValues {
	return values.status !== "";
}

/**
 * Form values as the procedure's input.
 *
 * Takes only completed values: an unanswered status is never converted into a
 * default here, and `""` never reaches the procedure's enum.
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
	values: CompletedRepairCompanyFormValues,
): RepairCompanyPayload {
	return {
		companyName: values.companyName.trim(),
		phone: formatUsPhone(values.phone) ?? (values.phone.trim() || null),
		email: values.email.trim() || null,
		status: values.status,
	};
}

/**
 * Where a failed repair-company mutation's message belongs on the form.
 *
 * `createRepairCompany` and `updateRepairCompany` raise `CONFLICT` for exactly
 * one reason — the email address is already used by another repair company in
 * this purveyor — so the message goes under the Email input rather than into
 * the form-wide banner.
 */
export function repairCompanyFormErrors(
	error: { message: string; data?: { code?: string | null } | null } | null,
) {
	if (!error) return {};

	return error.data?.code === "CONFLICT"
		? { emailErrorMessage: error.message }
		: { errorMessage: error.message };
}

/** The spelling the server compares addresses in: trimmed and lowercased. */
function normalizedEmail(value: string) {
	return value.trim().toLowerCase();
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
	emailErrorMessage,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
}: {
	initialValues?: RepairCompanyFormValues;
	pending?: boolean;
	/** A server refusal with no field of its own. */
	errorMessage?: string;
	/** A server refusal about the email address — shown under that input. */
	emailErrorMessage?: string;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (payload: RepairCompanyPayload) => void;
	onCancel: () => void;
}) {
	const [values, setValues] = useState<RepairCompanyFormValues>(initialValues);
	// Which address the rejected request carried — see `CustomerForm`. The
	// refusal follows that address in any spelling and no other.
	const [rejectedEmail, setRejectedEmail] = useState<string | null>(null);

	const emailTaken =
		emailErrorMessage &&
		values.email.trim() !== "" &&
		rejectedEmail === normalizedEmail(values.email)
			? emailErrorMessage
			: undefined;

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
			status: required("Select a status."),
		},
		externalErrors: { email: emailTaken },
	});

	function update<Field extends keyof RepairCompanyFormValues>(
		field: Field,
		value: RepairCompanyFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!validation.validate() || !isCompletedRepairCompany(values)) return;

		setRejectedEmail(normalizedEmail(values.email));
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
					<Label htmlFor={validation.fieldId("status")}>Status</Label>
					<Select
						items={STATUS_LABELS}
						value={values.status || null}
						onValueChange={(value) =>
							update(
								"status",
								(value ?? "") as RepairCompanyFormValues["status"],
							)
						}
						disabled={pending}
					>
						<SelectTrigger {...validation.controlProps("status")} name="status">
							<SelectValue placeholder={SELECT_PLACEHOLDER} />
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
					<FieldError {...validation.errorProps("status")} />
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
