"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { Card } from "@bfa-platform/ui/components/card";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import { FieldError } from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	required,
	usDate,
	usDateToIso,
} from "@bfa-platform/ui/lib/validation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { trpc } from "@/utils/trpc";

/**
 * The certifier's own profile: contact/licence details, editable, and a
 * password change alongside it.
 *
 * Two different write paths, on purpose. `updateProfile` writes
 * `profiles.full_name` and the three `certifiers` columns 0006/0007 already
 * opened a self-write path for. A password is Supabase Auth's own record, not
 * a column in this schema, so it goes through `supabase.auth.updateUser`
 * directly — a server procedure for it would only be relaying a call the
 * caller's own session can already make.
 */
export function ProfileForm({ email }: { email: string | null }) {
	const queryClient = useQueryClient();

	const profile = useQuery(trpc.certifier.getProfile.queryOptions());

	const [fullName, setFullName] = useState("");
	const [company, setCompany] = useState("");
	const [idNumber, setIdNumber] = useState("");
	const [licenseExpiration, setLicenseExpiration] = useState("");

	// The form starts empty and fills in once the fetch lands, rather than
	// being a controlled mirror of the query the whole time — the certifier
	// is mid-edit by the time a background refetch could land, and a form
	// that re-synced under them would erase what they just typed.
	useEffect(() => {
		if (!profile.data) return;
		setFullName(profile.data.fullName ?? "");
		setCompany(profile.data.company ?? "");
		setIdNumber(profile.data.idNumber ?? "");
		setLicenseExpiration(
			profile.data.licenseExpirationDate
				? usIsoToDate(profile.data.licenseExpirationDate)
				: "",
		);
	}, [profile.data]);

	// All four Contact info fields are required — a product decision for this
	// form specifically, not the WP-side "blank clears the field" convention
	// `submission-input.ts` uses elsewhere. `updateProfileInput` on the server
	// enforces the same rule; this is what tells the certifier about it before
	// a request is made.
	const validation = useFormValidation({
		values: { fullName, company, idNumber, licenseExpiration },
		rules: {
			fullName: required("Full name is required."),
			company: required("Company is required."),
			idNumber: required("License or ID number is required."),
			licenseExpiration: composeRules(
				required("License expiration is required."),
				usDate(),
			),
		},
	});

	const save = useMutation(
		trpc.certifier.updateProfile.mutationOptions({
			onSuccess: async () => {
				toast.success("Profile saved");
				await queryClient.invalidateQueries({
					queryKey: trpc.certifier.getProfile.queryKey(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	function handleSubmit(event: React.FormEvent) {
		event.preventDefault();

		if (!validation.validate()) return;

		save.mutate({
			fullName: fullName.trim(),
			company: company.trim(),
			idNumber: idNumber.trim(),
			// Safe to assert: `validation.validate()` already refused a blank or
			// unparsable date, so this is always a real one by this point.
			licenseExpirationDate: usDateToIso(licenseExpiration) as string,
		});
	}

	return (
		<div className="flex flex-col gap-5">
			<Card className="flex w-full max-w-[640px] flex-col gap-4 p-5">
				<h2 className="font-semibold text-sm">Contact info</h2>

				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<Field label="Full name" htmlFor={validation.fieldId("fullName")}>
							<Input
								{...validation.controlProps("fullName")}
								value={fullName}
								onChange={(event) => setFullName(event.target.value)}
								placeholder="Full name"
							/>
							<FieldError {...validation.errorProps("fullName")} />
						</Field>

						<Field label="Email" htmlFor="cert-email">
							{/* Not part of this form's write path — email changes go
							    through Supabase Auth's own flow, which this task does
							    not build. */}
							<Input id="cert-email" value={email ?? ""} readOnly />
						</Field>
					</div>

					<Field label="Company" htmlFor={validation.fieldId("company")}>
						<Input
							{...validation.controlProps("company")}
							value={company}
							onChange={(event) => setCompany(event.target.value)}
							placeholder="Company"
						/>
						<FieldError {...validation.errorProps("company")} />
					</Field>

					<div className="grid gap-4 sm:grid-cols-2">
						<Field
							label="License / ID number"
							htmlFor={validation.fieldId("idNumber")}
						>
							<Input
								{...validation.controlProps("idNumber")}
								value={idNumber}
								onChange={(event) => setIdNumber(event.target.value)}
								placeholder="License or ID number"
							/>
							<FieldError {...validation.errorProps("idNumber")} />
						</Field>

						<Field
							label="License expiration"
							htmlFor={validation.fieldId("licenseExpiration")}
						>
							<DateInput
								pickerLabel="Choose license expiration date"
								{...validation.controlProps("licenseExpiration")}
								value={licenseExpiration}
								onValueChange={setLicenseExpiration}
							/>
							<FieldError {...validation.errorProps("licenseExpiration")} />
						</Field>
					</div>

					<Button type="submit" disabled={save.isPending || profile.isPending}>
						{save.isPending ? "Saving…" : "Save changes"}
					</Button>
				</form>
			</Card>

			<PasswordCard />
		</div>
	);
}

/** MM/DD/YYYY, no validation — this always comes from a value the server sent. */
function usIsoToDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	return `${month}/${day}/${year}`;
}

function Field({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}

/**
 * Change password, entirely client-side against Supabase Auth.
 *
 * `updateUser` requires the caller's own current session, which is already
 * the gate — there is no "current password" field, matching how Supabase's
 * own reset flow works for a signed-in user.
 */
function PasswordCard() {
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault();

		if (password.length < 8) {
			toast.error("Use at least 8 characters");
			return;
		}
		if (password !== confirm) {
			toast.error("Passwords don't match");
			return;
		}

		setIsSubmitting(true);
		const supabase = createClient();
		const { error } = await supabase.auth.updateUser({ password });
		setIsSubmitting(false);

		if (error) {
			toast.error(error.message);
			return;
		}

		setPassword("");
		setConfirm("");
		toast.success("Password updated");
	}

	return (
		<Card className="flex w-full max-w-[640px] flex-col gap-4 p-5">
			<h2 className="font-semibold text-sm">Change password</h2>
			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				<Field label="New password" htmlFor="cert-new-password">
					<Input
						id="cert-new-password"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						placeholder="New password"
					/>
				</Field>
				<Field label="Confirm new password" htmlFor="cert-confirm-password">
					<Input
						id="cert-confirm-password"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
						placeholder="Confirm new password"
					/>
				</Field>
				<Button type="submit" disabled={isSubmitting}>
					{isSubmitting ? "Updating…" : "Update password"}
				</Button>
			</form>
		</Card>
	);
}
