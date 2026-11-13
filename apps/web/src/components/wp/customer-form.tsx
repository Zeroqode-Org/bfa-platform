"use client";

import { ASSET_FIELD_LIMITS } from "@bfa-platform/api/lib/asset-field-limits";
import {
	isCustomerBinError,
	isCustomerBinReassignError,
} from "@bfa-platform/api/lib/customer-bin";
import { CUSTOMER_FIELD_LIMITS } from "@bfa-platform/api/lib/customer-field-limits";
import { CUSTOMER_EMAIL_TAKEN_MESSAGE } from "@bfa-platform/api/lib/email-uniqueness";
import { Badge } from "@bfa-platform/ui/components/badge";
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
	isoToUsDate,
	maxLength,
	required,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

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
 * The rate category and status may be `""`: a new customer opens with both
 * unanswered, so neither is a silent default somebody saved without choosing.
 *
 * `agRenewalDate` is the date as displayed, `MM/DD/YYYY`; the API's
 * `YYYY-MM-DD` exists only on the way in and out.
 *
 * `attachBin` is not a column of the customer: it is the BIN of an asset to
 * attach them to on save. It always opens empty — the BINs a customer already
 * holds are listed beside it, not loaded into it.
 */
export type CustomerFormValues = {
	attachBin: string;
	name: string;
	accountNumber: string;
	email: string;
	address: string;
	rateCategory: Customer["rateCategory"] | "";
	agRenewalDate: string;
	status: Customer["status"] | "";
};

/** Form values in which both selects hold a real choice — the only kind that is sent. */
export type CompletedCustomerFormValues = CustomerFormValues & {
	rateCategory: Customer["rateCategory"];
	status: Customer["status"];
};

export const emptyCustomerValues: CustomerFormValues = {
	attachBin: "",
	name: "",
	accountNumber: "",
	email: "",
	address: "",
	rateCategory: "",
	agRenewalDate: "",
	status: "",
};

/** An existing row as form values. Nullable columns become empty strings. */
export function customerToFormValues(
	customer: Customer,
): CompletedCustomerFormValues {
	return {
		attachBin: "",
		name: customer.name,
		accountNumber: customer.accountNumber ?? "",
		email: customer.email,
		address: customer.address ?? "",
		rateCategory: customer.rateCategory,
		agRenewalDate: isoToUsDate(customer.agRenewalDate),
		status: customer.status,
	};
}

/** Whether both selects have been answered, so the values may become a payload. */
export function isCompletedCustomer(
	values: CustomerFormValues,
): values is CompletedCustomerFormValues {
	return values.rateCategory !== "" && values.status !== "";
}

/**
 * Form values as the procedure's input.
 *
 * Takes only completed values: an unanswered select is never converted into a
 * default here, and `""` never reaches the procedure's enum.
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
	values: CompletedCustomerFormValues,
): CustomerPayload {
	const shared = {
		name: values.name.trim(),
		email: values.email.trim(),
		accountNumber: values.accountNumber.trim() || null,
		address: values.address.trim(),
		status: values.status,
		attachBin: values.attachBin.trim() || null,
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

/**
 * Where a failed customer mutation's message belongs on the form.
 *
 * `CONFLICT` covers two different failures now, and only one of them is about
 * a field: a duplicate address is the Email input's problem and its message
 * goes under that input, while a stale record (somebody else — or the AG
 * renewal notice's annual transition — changed the customer after this form
 * was opened) is about the whole record and goes in the form-wide banner.
 * They are told apart by the message rather than by the code, so a third
 * conflict added later lands in the banner instead of being mislabelled as an
 * email problem.
 *
 * The BIN has two kinds of refusal. A missing or unknown BIN goes under the
 * BIN field. A BIN that belongs to somebody else is a question rather than an
 * error — the form asks it there and offers to move the asset.
 */
export function customerFormErrors(
	error: { message: string; data?: { code?: string | null } | null } | null,
) {
	if (!error) return {};

	if (isCustomerBinReassignError(error)) {
		return { binReassignMessage: error.message };
	}
	if (isCustomerBinError(error)) return { binErrorMessage: error.message };

	return error.data?.code === "CONFLICT" &&
		error.message === CUSTOMER_EMAIL_TAKEN_MESSAGE
		? { emailErrorMessage: error.message }
		: { errorMessage: error.message };
}

/** The spelling the server matches a BIN in: trimmed, otherwise exact. */
function normalizedBin(value: string) {
	return value.trim();
}

/** The spelling the server compares addresses in: trimmed and lowercased. */
function normalizedEmail(value: string) {
	return value.trim().toLowerCase();
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
	heldBins = [],
	pending = false,
	errorMessage,
	emailErrorMessage,
	binErrorMessage,
	binReassignMessage,
	submitLabel,
	pendingLabel,
	onSubmit,
	onCancel,
}: {
	initialValues?: CustomerFormValues;
	/** BINs of the assets the customer already occupies; empty for a new one. */
	heldBins?: string[];
	pending?: boolean;
	/** A server refusal with no field of its own. */
	errorMessage?: string;
	/** A server refusal about the email address — shown under that input. */
	emailErrorMessage?: string;
	/** A missing or unknown BIN — shown under the BIN input. */
	binErrorMessage?: string;
	/** The BIN belongs to another customer — asked under the BIN input. */
	binReassignMessage?: string;
	submitLabel: string;
	pendingLabel: string;
	onSubmit: (payload: CustomerPayload) => void;
	onCancel: () => void;
}) {
	const [values, setValues] = useState<CustomerFormValues>(initialValues);
	// Which BIN the rejected request carried, for the same reason as the email
	// below: the server's answer is about that BIN and stops applying the moment
	// the field holds a different one.
	const [rejectedBin, setRejectedBin] = useState<string | null>(null);
	const binAnswerApplies = rejectedBin === normalizedBin(values.attachBin);
	const binRefusal =
		binErrorMessage && binAnswerApplies ? binErrorMessage : undefined;
	const reassignQuestion =
		binReassignMessage && binAnswerApplies ? binReassignMessage : undefined;
	const holdsAsset = heldBins.length > 0;
	// Which address the rejected request carried. The server's "already used"
	// answer is about that exact address, so it stops applying the moment the
	// field holds a different one — and comes back if the same address is typed
	// again in another spelling, because the server would refuse that too.
	const [rejectedEmail, setRejectedEmail] = useState<string | null>(null);

	const emailTaken =
		emailErrorMessage && rejectedEmail === normalizedEmail(values.email)
			? emailErrorMessage
			: undefined;

	const validation = useFormValidation({
		values,
		rules: {
			// Optional: purveyors match BINs to customers from their own lists
			// and may attach one later. See `customer-bin.ts`.
			attachBin: maxLength(ASSET_FIELD_LIMITS.bin),
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
			address: composeRules(
				required("Address is required."),
				maxLength(CUSTOMER_FIELD_LIMITS.address),
			),
			rateCategory: required("Select a rate category."),
			// Only the agricultural rate carries a renewal date, so only that rate
			// asks for one — the same condition the field's visibility uses.
			agRenewalDate: (value, current) =>
				current.rateCategory === "agricultural"
					? agRenewalDateRule(value)
					: undefined,
			status: required("Select a status."),
		},
		externalErrors: { email: emailTaken, attachBin: binRefusal },
	});

	function update<Field extends keyof CustomerFormValues>(
		field: Field,
		value: CustomerFormValues[Field],
	) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	const isAgricultural = values.rateCategory === "agricultural";

	function submit({ acknowledgeReassign }: { acknowledgeReassign: boolean }) {
		if (!validation.validate() || !isCompletedCustomer(values)) return;

		setRejectedEmail(normalizedEmail(values.email));
		setRejectedBin(normalizedBin(values.attachBin));
		onSubmit({
			...buildCustomerPayload(values),
			...(acknowledgeReassign ? { acknowledgeReassign: true } : {}),
		});
	}

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		submit({ acknowledgeReassign: false });
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
				{/* First, because it is what ties this record to anything: every
				    notice is addressed through an asset's current customer. */}
				<div className="flex flex-col gap-1.5">
					{holdsAsset ? (
						<div className="flex flex-col gap-1.5">
							<span className="font-medium text-[13px]">Attached BINs</span>
							<ul className="flex flex-wrap gap-1.5">
								{heldBins.map((bin) => (
									<li key={bin}>
										<Badge variant="primary">{bin}</Badge>
									</li>
								))}
							</ul>
						</div>
					) : null}
					<Label htmlFor={validation.fieldId("attachBin")}>
						{holdsAsset ? "Attach another BIN" : "BIN"}
					</Label>
					<Input
						{...validation.controlProps("attachBin")}
						name="attachBin"
						value={values.attachBin}
						onChange={(event) => update("attachBin", event.target.value)}
						placeholder="Optional"
						autoComplete="off"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("attachBin")} />
					{reassignQuestion ? (
						<div className="flex flex-col items-start gap-2 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning">
							<p className="flex items-start gap-1.5">
								<TriangleAlert
									className="mt-px size-4 shrink-0"
									aria-hidden="true"
								/>
								{reassignQuestion}
							</p>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								disabled={pending}
								onClick={() => submit({ acknowledgeReassign: true })}
							>
								Move it to this customer
							</Button>
						</div>
					) : (
						<p className="text-[12px] text-muted-foreground">
							Saving makes this customer the assembly&rsquo;s current occupant —
							its reminders and notices go to them from then on.
							{holdsAsset
								? " To remove a BIN, use De-link on the Customers table."
								: " Leave it empty to attach one later; until then this customer gets no test reminders or failure notices."}
						</p>
					)}
				</div>

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
						placeholder="1450 Ala Moana Blvd"
						autoComplete="off"
						disabled={pending}
						aria-required="true"
					/>
					<FieldError {...validation.errorProps("address")} />
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("rateCategory")}>
							Rate category
						</Label>
						<Select
							items={RATE_CATEGORY_LABELS}
							value={values.rateCategory || null}
							onValueChange={(value) =>
								update(
									"rateCategory",
									(value ?? "") as CustomerFormValues["rateCategory"],
								)
							}
							disabled={pending}
						>
							<SelectTrigger
								{...validation.controlProps("rateCategory")}
								name="rateCategory"
							>
								<SelectValue placeholder={SELECT_PLACEHOLDER} />
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
						<FieldError {...validation.errorProps("rateCategory")} />
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
					<Label htmlFor={validation.fieldId("status")}>Status</Label>
					<Select
						items={STATUS_LABELS}
						value={values.status || null}
						onValueChange={(value) =>
							update("status", (value ?? "") as CustomerFormValues["status"])
						}
						disabled={pending}
					>
						<SelectTrigger {...validation.controlProps("status")} name="status">
							<SelectValue placeholder={SELECT_PLACEHOLDER} />
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
					<FieldError {...validation.errorProps("status")} />
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
