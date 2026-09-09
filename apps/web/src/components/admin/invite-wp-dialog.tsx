"use client";

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
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { useMutation } from "@tanstack/react-query";
import { Plus, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
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
	const companyNameId = useId();
	const contactEmailId = useId();
	const errorId = useId();

	const [companyName, setCompanyName] = useState("");
	const [contactEmail, setContactEmail] = useState("");

	const createInvitation = useMutation(
		trpc.invitations.createInvitation.mutationOptions({
			onSuccess: (invitation) => {
				// Say what actually happened. Until the provider lands the console
				// driver is the only delivery there is, and telling a Super-Admin an
				// email was sent would have them waiting for one that never arrives.
				toast.success(`Invitation created for ${invitation.email}`, {
					description: `${invitation.proposedWaterPurveyorName ?? "The water purveyor"} is created when the link is redeemed. No email provider is configured yet — the invite link is in the server log.`,
				});
				setCompanyName("");
				setContactEmail("");
				onClose();
			},
		}),
	);

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();

		createInvitation.mutate({
			email: contactEmail,
			role: "wp_admin",
			// Null is what provisions a purveyor rather than joining one, and only
			// a Super-Admin may send it. The server decides that from the caller's
			// own profile; this value is a request, not an authorization.
			waterPurveyorId: null,
			proposedWaterPurveyorName: companyName,
		});
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={companyNameId}>Company name</Label>
				<Input
					id={companyNameId}
					name="companyName"
					value={companyName}
					onChange={(event) => setCompanyName(event.target.value)}
					placeholder="Riverside Water District"
					autoComplete="organization"
					disabled={createInvitation.isPending}
					required
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={contactEmailId}>Contact email</Label>
				<Input
					id={contactEmailId}
					name="contactEmail"
					type="email"
					value={contactEmail}
					onChange={(event) => setContactEmail(event.target.value)}
					placeholder="admin@riversidewater.gov"
					autoComplete="email"
					disabled={createInvitation.isPending}
					required
				/>
			</div>

			{createInvitation.isError ? (
				<p
					id={errorId}
					role="alert"
					className="flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{createInvitation.error.message}
				</p>
			) : null}

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
