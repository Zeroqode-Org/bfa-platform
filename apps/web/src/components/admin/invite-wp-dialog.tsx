"use client";

import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@bfa-platform/ui/components/dialog";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

/**
 * Invite-new-WP form layout, per the prototype's invite modal: company name and
 * the contact email the invitation goes to.
 *
 * Week 1 is layout only — submitting closes the dialog and confirms locally.
 * Week 4 wires it to the invite action, which reuses the invitation machinery
 * with a null `associated_wp_id`; redemption then creates the `water_purveyors`
 * row and the first WP Admin profile in one transaction.
 */
export function InviteWpDialog() {
	const companyNameId = useId();
	const contactEmailId = useId();

	const [open, setOpen] = useState(false);
	const [companyName, setCompanyName] = useState("");
	const [contactEmail, setContactEmail] = useState("");

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// Week 4: replace with the invite-new-WP action.
		toast.success(`Invitation queued for ${companyName.trim()}`, {
			description: `Week 1 is UI only — nothing was sent to ${contactEmail.trim()}.`,
		});
		setCompanyName("");
		setContactEmail("");
		setOpen(false);
	}

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
							required
						/>
					</div>

					<DialogFooter>
						<DialogClose render={<Button variant="secondary">Cancel</Button>} />
						<Button type="submit">Send invite</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
