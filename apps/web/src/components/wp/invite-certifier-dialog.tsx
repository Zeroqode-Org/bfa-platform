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
 * Invite-certifier action on the WP certifiers screen.
 *
 * Runs on the existing `invitations.createInvitation` procedure — the same one
 * behind the Super-Admin's invite-new-WP dialog. There is no certifier-specific
 * invitation backend: token generation, storage, delivery and redemption all
 * live in one place, and a second copy of any of them would be a second set of
 * expiry and single-use rules to keep in step.
 *
 * All three WP roles may send one (PRD § 9, confirmed), so there is no role gate
 * on this control.
 */
export function InviteCertifierDialog() {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button size="sm">
						<Plus />
						<span className="hidden min-[560px]:inline">Invite certifier</span>
						<span className="min-[560px]:hidden">Invite</span>
					</Button>
				}
			/>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Invite certifier</DialogTitle>
					<DialogDescription>
						The certifier receives an invitation link. Redeeming it authorizes
						them for your water purveyor — if they already have an account, they
						keep it and simply gain your purveyor.
					</DialogDescription>
				</DialogHeader>

				<InviteCertifierForm onClose={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
}

/**
 * The form itself, split out from the dialog shell so the submit behaviour can
 * be exercised without driving a modal's portal and focus trap — the same split
 * `InviteWpForm` uses.
 */
export function InviteCertifierForm({ onClose }: { onClose: () => void }) {
	const emailId = useId();
	const errorId = useId();

	const [email, setEmail] = useState("");

	const createInvitation = useMutation(
		trpc.invitations.createInvitation.mutationOptions({
			onSuccess: (invitation) => {
				// Say what actually happened. Until the provider lands the console
				// driver is the only delivery there is, and telling a clerk an email
				// went out would have them waiting for one that never arrives — and,
				// worse, waiting instead of copying the link out of the log.
				toast.success(`Invitation created for ${invitation.email}`, {
					description:
						"They join your water purveyor when the link is redeemed. No email provider is configured yet — the invite link is in the server log.",
				});
				setEmail("");
				onClose();
			},
			// No toast on failure: the message goes inline, next to the field the
			// person still has to correct.
		}),
	);

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();

		createInvitation.mutate({
			email,
			role: "certifier",
			// No `waterPurveyorId`. The server reads the tenant off the caller's own
			// profile and refuses a WP role that names one, so there is deliberately
			// nothing to send — a client cannot invite into somebody else's purveyor
			// because it has no field in which to ask.
		});
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={emailId}>Certifier email</Label>
				<Input
					id={emailId}
					name="certifierEmail"
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="tester@example.com"
					autoComplete="email"
					aria-describedby={createInvitation.isError ? errorId : undefined}
					disabled={createInvitation.isPending}
					required
				/>
				<p className="text-[12px] text-muted-foreground">
					A certifier who already works for another purveyor keeps their profile
					— the link only adds yours.
				</p>
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
