"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	maxLength,
	required,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { useActionState, useId, useState } from "react";

import {
	type RedeemState,
	redeemInvitationAction,
} from "@/app/invite/[token]/actions";
import { PASSWORD_HINT, passwordPolicyError } from "@/lib/password-policy";
import { REDEEM_FIELD_LIMITS } from "@/lib/redeem-field-limits";

export type RedeemFormProps = {
	secret: string;
	mode: "new_profile" | "new_water_purveyor" | "existing_certifier";
	isCertifier: boolean;
};

const initialState: RedeemState = { error: null };

type RedeemValues = {
	fullName: string;
	certifierCompany: string;
	certifierIdNumber: string;
	licenseExpirationDate: string;
	password: string;
	confirmPassword: string;
};

const EMPTY_VALUES: RedeemValues = {
	fullName: "",
	certifierCompany: "",
	certifierIdNumber: "",
	licenseExpirationDate: "",
	password: "",
	confirmPassword: "",
};

const passwordRule = composeRules(
	required("Password is required."),
	(value) => (value ? passwordPolicyError(value) : undefined),
	maxLength(REDEEM_FIELD_LIMITS.password, { trim: false }),
);

const certifierRules = {
	certifierCompany: composeRules(
		required("Company is required."),
		maxLength(REDEEM_FIELD_LIMITS.certifierCompany),
	),
	certifierIdNumber: composeRules(
		required("Certifier ID number is required."),
		maxLength(REDEEM_FIELD_LIMITS.certifierIdNumber),
	),
	licenseExpirationDate: composeRules(
		required("License expiration date is required."),
		usDate(),
	),
};

/**
 * First-login form. Which fields appear is decided on the server from the
 * invitation itself — the mode and role are passed in, not chosen here, so a
 * tampered form cannot ask for (or skip) a different set of fields than the
 * invitation calls for. The action revalidates all of it anyway.
 *
 * The inline rules below mirror the action's so a missing field is reported
 * at the field before anything is sent. They are not the boundary: the action
 * parses the submitted `FormData` again, and its own refusal comes back as the
 * form-level message.
 */
export function RedeemForm({ secret, mode, isCertifier }: RedeemFormProps) {
	const passwordHintId = useId();

	const [state, formAction, isPending] = useActionState(
		redeemInvitationAction,
		initialState,
	);
	const [values, setValues] = useState(EMPTY_VALUES);

	const isExistingCertifier = mode === "existing_certifier";
	const asksForProfile = !isExistingCertifier;
	const asksForCertifier = isCertifier && asksForProfile;

	const validation = useFormValidation({
		values,
		rules: {
			fullName: (value) =>
				asksForProfile
					? composeRules(
							required("Full name is required."),
							maxLength(REDEEM_FIELD_LIMITS.fullName),
						)(value)
					: undefined,
			certifierCompany: (value) =>
				asksForCertifier ? certifierRules.certifierCompany(value) : undefined,
			certifierIdNumber: (value) =>
				asksForCertifier ? certifierRules.certifierIdNumber(value) : undefined,
			licenseExpirationDate: (value) =>
				asksForCertifier
					? certifierRules.licenseExpirationDate(value)
					: undefined,
			password: (value) => (asksForProfile ? passwordRule(value) : undefined),
			confirmPassword: (value, current) => {
				if (!asksForProfile) return undefined;
				if (!value) return "Confirm your password.";

				return value === current.password
					? undefined
					: "The passwords do not match.";
			},
		},
	});

	function update(field: keyof RedeemValues, value: string) {
		setValues((current) => ({ ...current, [field]: value }));
	}

	return (
		<form
			action={formAction}
			// Cancelling the submit event is what stops React dispatching the
			// action, so an invalid form never reaches the server at all.
			onSubmit={(event) => {
				if (!validation.validate()) event.preventDefault();
			}}
			className="mt-6 flex flex-col gap-4"
			noValidate
		>
			<input type="hidden" name="secret" value={secret} />
			<input type="hidden" name="mode" value={mode} />
			<input
				type="hidden"
				name="isCertifier"
				value={asksForCertifier ? "yes" : "no"}
			/>

			{isExistingCertifier ? null : (
				<>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("fullName")}>Full name</Label>
						<Input
							{...validation.controlProps("fullName")}
							name="fullName"
							autoComplete="name"
							placeholder="Alex Rivera"
							value={values.fullName}
							onChange={(event) => update("fullName", event.target.value)}
						/>
						<FieldError {...validation.errorProps("fullName")} />
					</div>

					{isCertifier ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={validation.fieldId("certifierCompany")}>
									Company
								</Label>
								<Input
									{...validation.controlProps("certifierCompany")}
									name="certifierCompany"
									autoComplete="organization"
									placeholder="Rivera Backflow Testing"
									value={values.certifierCompany}
									onChange={(event) =>
										update("certifierCompany", event.target.value)
									}
								/>
								<FieldError {...validation.errorProps("certifierCompany")} />
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor={validation.fieldId("certifierIdNumber")}>
									Certifier ID number
								</Label>
								<Input
									{...validation.controlProps("certifierIdNumber")}
									name="certifierIdNumber"
									placeholder="CERT-00123"
									value={values.certifierIdNumber}
									onChange={(event) =>
										update("certifierIdNumber", event.target.value)
									}
								/>
								<FieldError {...validation.errorProps("certifierIdNumber")} />
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor={validation.fieldId("licenseExpirationDate")}>
									License expiration date
								</Label>
								<DateInput
									pickerLabel="Choose license expiration date"
									{...validation.controlProps("licenseExpirationDate")}
									value={values.licenseExpirationDate}
									onValueChange={(value) =>
										update("licenseExpirationDate", value)
									}
								/>
								{/* The action takes the API's `YYYY-MM-DD`; the person types
								    `MM/DD/YYYY`. The conversion is here, at the boundary. */}
								<input
									type="hidden"
									name="licenseExpirationDate"
									value={usDateToIso(values.licenseExpirationDate) ?? ""}
								/>
								<FieldError
									{...validation.errorProps("licenseExpirationDate")}
								/>
							</div>
						</>
					) : null}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("password")}>Password</Label>
						<Input
							{...validation.controlProps("password", {
								describedBy: passwordHintId,
							})}
							name="password"
							type="password"
							autoComplete="new-password"
							value={values.password}
							onChange={(event) => update("password", event.target.value)}
						/>
						<FieldError {...validation.errorProps("password")} />
						<p
							id={passwordHintId}
							className="text-[12px] text-muted-foreground"
						>
							{PASSWORD_HINT}
						</p>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("confirmPassword")}>
							Confirm password
						</Label>
						<Input
							{...validation.controlProps("confirmPassword")}
							name="confirmPassword"
							type="password"
							autoComplete="new-password"
							value={values.confirmPassword}
							onChange={(event) =>
								update("confirmPassword", event.target.value)
							}
						/>
						<FieldError {...validation.errorProps("confirmPassword")} />
					</div>
				</>
			)}

			<FormError message={state.error} />

			<Button type="submit" disabled={isPending} className="mt-1 w-full">
				{isPending
					? "Setting things up…"
					: isExistingCertifier
						? "Add this water purveyor"
						: "Create my account"}
			</Button>
		</form>
	);
}
