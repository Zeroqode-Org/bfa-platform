"use client";

import { Button } from "@bfa-platform/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@bfa-platform/ui/components/dialog";
import { useState } from "react";

import { ContactForm } from "./contact-form";

/**
 * "Try it out now" — there is no self-serve sign-up (accounts are created by
 * invitation), so trying the platform starts with a conversation: the button
 * opens the same inquiry form the Contact section shows.
 *
 * The form is remounted each time the dialog opens — a new `key` per opening —
 * so a visitor who sent one inquiry and opens it again starts from an empty
 * form, not a stale "thanks". It stays mounted while closing, so the popup
 * keeps its content through the exit animation.
 */
export function TryItDialog() {
	const [open, setOpen] = useState(false);
	const [opening, setOpening] = useState(0);

	function handleOpenChange(next: boolean) {
		if (next) setOpening((count) => count + 1);
		setOpen(next);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger
				render={
					<Button
						size="lg"
						className="px-6 font-semibold uppercase tracking-wide"
					>
						Try it out now
					</Button>
				}
			/>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Try Backflow Reporter</DialogTitle>
					<DialogDescription>
						Tell us a little about your program and we will set up access for
						your team.
					</DialogDescription>
				</DialogHeader>
				<ContactForm key={opening} onDone={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
}
