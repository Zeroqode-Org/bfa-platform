"use client";

import { CUSTOMER_FIELD_LIMITS } from "@bfa-platform/api/lib/customer-field-limits";
import { Button } from "@bfa-platform/ui/components/button";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import { DialogBody, DialogFooter } from "@bfa-platform/ui/components/dialog";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
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
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	email,
	isoToUsDate,
	maxLength,
	required,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import type { Customer, CustomerPayload } from "./customer-types";
import { SUSPENSION_WARNING } from "./customer-types";

export const RATE_CATEGORY_LABELS = {
	standard: "Standard",
	agricultural: "Agricultural",
} as const;

export const STATUS_LABELS = {
	active: "Active",
	suspended: "Suspended",
} as const;

/**
 * What the form holds while it is being typed into. Every field is a string,
 * including the two enums and the date, because that is what an input hands
 * back — the conversion to the procedure's shape happens once, in
 * `buildCustomerPayload`.
 *
 * `agRenewalDate` is the date as displayed, `MM/DD/YYYY`; the API's
 * `YYYY-MM-DD` exists only on the way in and out.
 */
export type CustomerFormValues = {
	name: string;
	accountNumber: string;
	email: string;
	address: string;
	rateCategory: Customer["rateCategory"];
	agRenewalDate: string;
	status: Customer["status"];
};

export const emptyCustomerValues: CustomerFormValues = {
	name: "",
	accountNumber: "",
	email: "",
	address: "",
	rateCategory: "standard",
	agRenewalDate: "",
	status: "active",
};

/** An existing row as form values. Nullable columns become empty strings. */
export function customerToFormValues(customer: Customer): CustomerFormValues {
	return {
		name: customer.name,
		accountNumber: customer.accountNumber ?? "",
		email: customer.email,
		address: customer.address ?? "",
		rateCategory: customer.rateCategory,
		agRenewalDate: isoToUsDate(customer.agRenewalDate),
		status: customer.status,
	};
}

/**
 * Form values as the procedure's input.
 *
 * The renewal date is dropped for a standard customer rather than carried
 * along, which matches what the server stores: switching a customer off the
 * agricultural rate clears the date instead of leaving a stale one behind. The
 * server refuses a date on a standard customer outright, so sending the typed
 * value "just in case" would turn an edit into a validation error.
 *
 * An agricultural date goes out as the API's `YYYY-MM-DD`. One that is not a
 * real day is sent as typed rather than blanked — the form does not submit it,
 * and if something else does, the server's refusal is the honest answer.
 */
export function buildCustomerPayload(
	values: CustomerFormValues,
): CustomerPayload {
	const shared = {
		name: values.name.trim(),
		email: values.email.trim(),
		accountNumber: values.accountNumber.trim() || null,
		address: values.address.trim() || null,
		status: values.status,
	};

	return values.rateCategory === "agricultural"
		? {
				...shared,
				rateCategory: "agricultural",
				agRenewalDate:
					usDateToIso(values.agRenewalDate) ?? values.agRenewalDate,
			}
		: { ...shared, rateCategory: "standard", agRenewalDate: null };
}

const agRenewalDateRule = composeRules(
	required("AG renewal date is required."),
	usDate(),
);

/**
 * Create and edit are the same form — the only differences are the starting
 * values and the button label, and splitting them would leave two copies of the
 * agricultural rule to keep in step.
 *
 * Split out from its dialog so the submit behaviour can be exercised without
 * driving a modal's portal and focus trap, the same way `InviteWpForm` is.
 */
export function CustomerForm({
	initialValues = emptyCustomerValues,
	pending = false,
	errorMessage,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
}: {
	initialValues?: CustomerFormValues;
	pending?: boolean;
	errorMessage?: string;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (payload: CustomerPayload) => void;
	onCancel: () => void;
}) {
	const rateCategoryId = useId();
	const statusId = useId();

	const [values, setValues] = useState<CustomerFormValues>(initialValues);

	const validation = useFormValidation({
		values,
		rules: {
			name: composeRules(
				required("Name is required."),
				maxLength(CUSTOMER_FIELD_LIMITS.name),
			),
			email: composeRules(
				required("Email is required."),
				email(),
				maxLength(CUSTOMER_FIELD_LIMITS.email),
			),
			accountNumber: maxLength(CUSTOMER_FIELD_LIMITS.accountNumber),
			address: maxLength(CUSTOMER_FIELD_LIMITS.address),
			// Only the agricultural rate carries a renewal date, so only that rate
			// asks for one — the same condition the field's visibility uses.
			agRenewalDate: (value, current) =>
				current.rateCategory === "agricultural"
					? agRenewalDateRule(value)
					: undefined,
		},
	});

	function update<Field extends keyof CustomerFormValues>(
		field: Field,
		value: CustomerFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	const isAgricultural = values.rateCategory === "agricultural";

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!validation.validate()) return;

		onSubmit(buildCustomerPayload(values));
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
					<Label htmlFor={validation.fieldId("name")}>Name</Label>
					<Input
						{...validation.controlProps("name")}
						name="name"
						value={values.name}
						onChange={(event) => update("name", event.target.value)}
						placeholder="Marta Ellison"
						autoComplete="off"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("name")} />
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("accountNumber")}>
							Account number
						</Label>
						<Input
							{...validation.controlProps("accountNumber")}
							name="accountNumber"
							value={values.accountNumber}
							onChange={(event) => update("accountNumber", event.target.value)}
							placeholder="Optional"
							autoComplete="off"
							disabled={pending}
						/>
						<FieldError {...validation.errorProps("accountNumber")} />
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("email")}>Email</Label>
						<Input
							{...validation.controlProps("email")}
							name="email"
							type="email"
							value={values.email}
							onChange={(event) => update("email", event.target.value)}
							placeholder="marta@example.com"
							autoComplete="off"
							disabled={pending}
						/>
						<FieldError {...validation.errorProps("email")} />
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("address")}>Address</Label>
					<Input
						{...validation.controlProps("address")}
						name="address"
						value={values.address}
						onChange={(event) => update("address", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("address")} />
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={rateCategoryId}>Rate category</Label>
						<Select
							items={RATE_CATEGORY_LABELS}
							value={values.rateCategory}
							onValueChange={(value) =>
								update("rateCategory", value as Customer["rateCategory"])
							}
							disabled={pending}
						>
							<SelectTrigger id={rateCategoryId} name="rateCategory">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="standard">
										{RATE_CATEGORY_LABELS.standard}
									</SelectItem>
									<SelectItem value="agricultural">
										{RATE_CATEGORY_LABELS.agricultural}
									</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>

					{/* Only the agricultural rate has a renewal to notice, so the field
					    appears with the rate rather than sitting greyed out beside it. */}
					{isAgricultural ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={validation.fieldId("agRenewalDate")}>
								AG renewal date
							</Label>
							<DateInput
								pickerLabel="Choose AG renewal date"
								{...validation.controlProps("agRenewalDate")}
								name="agRenewalDate"
								value={values.agRenewalDate}
								onValueChange={(value) => update("agRenewalDate", value)}
								disabled={pending}
								aria-required="true"
							/>
							<FieldError {...validation.errorProps("agRenewalDate")} />
						</div>
					) : null}
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={statusId}>Status</Label>
					<Select
						items={STATUS_LABELS}
						value={values.status}
						onValueChange={(value) =>
							update("status", value as Customer["status"])
						}
						disabled={pending}
					>
						<SelectTrigger id={statusId} name="status">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectItem value="active">{STATUS_LABELS.active}</SelectItem>
								<SelectItem value="suspended">
									{STATUS_LABELS.suspended}
								</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>

				{/* Suspension is the one field here with a consequence outside this
				    form, so it says so at the moment it is chosen — not after saving. */}
				{values.status === "suspended" ? (
					<p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning">
						<TriangleAlert
							className="mt-px size-4 shrink-0"
							aria-hidden="true"
						/>
						{SUSPENSION_WARNING}
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
