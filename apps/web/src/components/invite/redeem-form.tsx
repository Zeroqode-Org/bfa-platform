"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { TriangleAlert } from "lucide-react";
import { useActionState, useId } from "react";

import {
	type RedeemState,
	redeemInvitationAction,
} from "@/app/invite/[token]/actions";

export type RedeemFormProps = {
	secret: string;
	mode: "new_profile" | "new_water_purveyor" | "existing_certifier";
	isCertifier: boolean;
};

const initialState: RedeemState = { error: null };

/**
 * First-login form. Which fields appear is decided on the server from the
 * invitation itself — the mode and role are passed in, not chosen here, so a
 * tampered form cannot ask for (or skip) a different set of fields than the
 * invitation calls for. The action revalidates all of it anyway.
 */
export function RedeemForm({ secret, mode, isCertifier }: RedeemFormProps) {
	const fullNameId = useId();
	const companyNameId = useId();
	const passwordId = useId();
	const confirmPasswordId = useId();
	const certifierCompanyId = useId();
	const certifierIdNumberId = useId();
	const licenseExpirationId = useId();
	const errorId = useId();

	const [state, formAction, isPending] = useActionState(
		redeemInvitationAction,
		initialState,
	);

	const isExistingCertifier = mode === "existing_certifier";

	return (
		<form action={formAction} className="mt-6 flex flex-col gap-4">
			<input type="hidden" name="secret" value={secret} />
			<input type="hidden" name="mode" value={mode} />
			<input
				type="hidden"
				name="isCertifier"
				value={isCertifier && !isExistingCertifier ? "yes" : "no"}
			/>

			{isExistingCertifier ? null : (
				<>
					{mode === "new_water_purveyor" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={companyNameId}>Company name</Label>
							<Input
								id={companyNameId}
								name="companyName"
								autoComplete="organization"
								placeholder="Riverside Water District"
								required
							/>
							<p className="text-[12px] text-muted-foreground">
								This becomes the water purveyor you administer.
							</p>
						</div>
					) : null}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={fullNameId}>Full name</Label>
						<Input
							id={fullNameId}
							name="fullName"
							autoComplete="name"
							placeholder="Alex Rivera"
							required
						/>
					</div>

					{isCertifier ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={certifierCompanyId}>Company</Label>
								<Input
									id={certifierCompanyId}
									name="certifierCompany"
									autoComplete="organization"
									placeholder="Rivera Backflow Testing"
									required
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor={certifierIdNumberId}>Certifier ID number</Label>
								<Input
									id={certifierIdNumberId}
									name="certifierIdNumber"
									placeholder="CERT-00123"
									required
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor={licenseExpirationId}>
									License expiration date
								</Label>
								<Input
									id={licenseExpirationId}
									name="licenseExpirationDate"
									type="date"
									required
								/>
							</div>
						</>
					) : null}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={passwordId}>Password</Label>
						<Input
							id={passwordId}
							name="password"
							type="password"
							autoComplete="new-password"
							minLength={8}
							required
						/>
						<p className="text-[12px] text-muted-foreground">
							At least 8 characters.
						</p>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={confirmPasswordId}>Confirm password</Label>
						<Input
							id={confirmPasswordId}
							name="confirmPassword"
							type="password"
							autoComplete="new-password"
							minLength={8}
							required
						/>
					</div>
				</>
			)}

			{state.error ? (
				<p
					id={errorId}
					role="alert"
					className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{state.error}
				</p>
			) : null}

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
