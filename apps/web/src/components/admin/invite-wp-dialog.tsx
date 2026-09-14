"use client";

import { INVITATION_FIELD_LIMITS } from "@bfa-platform/api/lib/invitation-field-limits";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@bfa-platform/ui/components/dialog";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	email,
	maxLength,
	required,
} from "@bfa-platform/ui/lib/validation";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

/**
 * Invite-new-WP action. The Super-Admin names the purveyor and the address of
 * its first administrator; redeeming the link creates the `water_purveyors` row
 * and that administrator's profile in one transaction.
 *
 * The name is collected here and stored on the invitation, so the person
 * redeeming it is never asked to name an organisation that has already been
 * named for them.
 *
 * Super-Admin only — enforced by the `/admin` route gate, again by
 * `createInvitation` (a null `associated_wp_id` is refused for every other
 * role), and again by a check constraint on the table. This component is the
 * affordance, not the boundary.
 */
export function InviteWpDialog() {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button size="sm">
						<Plus />
						<span className="hidden min-[560px]:inline">Invite new WP</span>
						<span className="min-[560px]:hidden">Invite</span>
					</Button>
				}
			/>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Invite water purveyor</DialogTitle>
					<DialogDescription>
						The contact receives an invitation link. Redeeming it creates the
						water purveyor and its first admin account.
					</DialogDescription>
				</DialogHeader>

				<InviteWpForm onClose={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
}

/**
 * The form itself, split out from the dialog shell so the submit behaviour can
 * be exercised without driving a modal's portal and focus trap.
 *
 * Cancel closes through `onClose` rather than through `Dialog.Close`, which
 * would tie the form to a dialog context it otherwise does not need.
 */
export function InviteWpForm({ onClose }: { onClose: () => void }) {
	const [values, setValues] = useState({ companyName: "", contactEmail: "" });

	const validation = useFormValidation({
		values,
		rules: {
			companyName: composeRules(
				required("Company name is required."),
				maxLength(INVITATION_FIELD_LIMITS.proposedWaterPurveyorName),
			),
			contactEmail: composeRules(
				required("Contact email is required."),
				email(),
				maxLength(INVITATION_FIELD_LIMITS.email),
			),
		},
	});

	const createInvitation = useMutation(
		trpc.invitations.createInvitation.mutationOptions({
			onSuccess: (invitation) => {
				const deliveryMessage =
					invitation.emailDelivery === "sent"
						? "An invitation email has been sent."
						: "Email delivery is not enabled; the invite link is available in the server log.";

				toast.success(`Invitation created for ${invitation.email}`, {
					description: `${invitation.proposedWaterPurveyorName ?? "The water purveyor"} is created when the link is redeemed. ${deliveryMessage}`,
				});
				setValues({ companyName: "", contactEmail: "" });
				onClose();
			},
			// No toast on failure: the message goes inline, above the buttons.
		}),
	);

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!validation.validate()) return;

		createInvitation.mutate({
			email: values.contactEmail,
			role: "wp_admin",
			// Null is what provisions a purveyor rather than joining one, and only
			// a Super-Admin may send it. The server decides that from the caller's
			// own profile; this value is a request, not an authorization.
			waterPurveyorId: null,
			proposedWaterPurveyorName: values.companyName,
		});
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId("companyName")}>Company name</Label>
				<Input
					{...validation.controlProps("companyName")}
					name="companyName"
					value={values.companyName}
					onChange={(event) =>
						setValues((current) => ({
							...current,
							companyName: event.target.value,
						}))
					}
					placeholder="Riverside Water District"
					autoComplete="organization"
					disabled={createInvitation.isPending}
				/>
				<FieldError {...validation.errorProps("companyName")} />
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId("contactEmail")}>
					Contact email
				</Label>
				<Input
					{...validation.controlProps("contactEmail")}
					name="contactEmail"
					type="email"
					value={values.contactEmail}
					onChange={(event) =>
						setValues((current) => ({
							...current,
							contactEmail: event.target.value,
						}))
					}
					placeholder="admin@riversidewater.gov"
					autoComplete="email"
					disabled={createInvitation.isPending}
				/>
				<FieldError {...validation.errorProps("contactEmail")} />
			</div>

			<FormError
				message={
					createInvitation.isError ? createInvitation.error.message : null
				}
			/>

			<DialogFooter>
				<Button
					type="button"
					variant="secondary"
					onClick={onClose}
					disabled={createInvitation.isPending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={createInvitation.isPending}>
					{createInvitation.isPending ? "Sending invite…" : "Send invite"}
				</Button>
			</DialogFooter>
		</form>
	);
}
