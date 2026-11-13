"use client";

import { CONTACT_INQUIRY_LIMITS } from "@bfa-platform/api/lib/contact-inquiry-limits";
import { Button } from "@bfa-platform/ui/components/button";
import {
	FieldError,
	FormError,
} from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { Textarea } from "@bfa-platform/ui/components/textarea";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	email,
	maxLength,
	required,
} from "@bfa-platform/ui/lib/validation";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useId, useState } from "react";

import { trpc } from "@/utils/trpc";

const EMPTY = { name: "", organization: "", email: "", message: "" };

/**
 * The landing page's inquiry form, used twice: inline in the Contact section
 * and inside the "Try it out" dialog. The inquiry is emailed to the Backflow
 * Reporter inbox by `contact.submit`; nothing is stored.
 *
 * On success the form is replaced by a confirmation, so a second click cannot
 * send the same inquiry twice. `onDone`, when given, adds a button that hands
 * control back — the dialog uses it to close.
 */
export function ContactForm({ onDone }: { onDone?: () => void }) {
	const [values, setValues] = useState(EMPTY);
	const [website, setWebsite] = useState("");
	const honeypotId = useId();

	const validation = useFormValidation({
		values,
		rules: {
			name: composeRules(
				required("Please enter your name."),
				maxLength(CONTACT_INQUIRY_LIMITS.name),
			),
			organization: maxLength(CONTACT_INQUIRY_LIMITS.organization),
			email: composeRules(
				required("Please enter your email address."),
				email(),
				maxLength(CONTACT_INQUIRY_LIMITS.email),
			),
			message: composeRules(
				required("Please enter a message."),
				maxLength(CONTACT_INQUIRY_LIMITS.message),
			),
		},
	});

	const submit = useMutation(trpc.contact.submit.mutationOptions());

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!validation.validate()) return;

		submit.mutate({ ...values, website });
	}

	function update(field: keyof typeof EMPTY) {
		return (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			setValues((current) => ({ ...current, [field]: event.target.value }));
	}

	if (submit.isSuccess) {
		return (
			<div
				role="status"
				className="flex flex-col items-start gap-3 rounded-lg border border-primary/30 bg-accent/50 p-5"
			>
				<div className="flex items-center gap-2 font-semibold text-foreground">
					<CheckCircle2 className="size-5 text-primary" aria-hidden="true" />
					Inquiry received
				</div>
				<p className="text-muted-foreground text-sm">
					Thanks — our team will be in touch shortly.
				</p>
				{onDone ? (
					<Button type="button" variant="secondary" onClick={onDone}>
						Close
					</Button>
				) : null}
			</div>
		);
	}

	const pending = submit.isPending;

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("name")}>Name</Label>
					<Input
						{...validation.controlProps("name")}
						name="name"
						value={values.name}
						onChange={update("name")}
						autoComplete="name"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("name")} />
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={validation.fieldId("organization")}>
						Organization
					</Label>
					<Input
						{...validation.controlProps("organization")}
						name="organization"
						value={values.organization}
						onChange={update("organization")}
						autoComplete="organization"
						disabled={pending}
					/>
					<FieldError {...validation.errorProps("organization")} />
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId("email")}>Email address</Label>
				<Input
					{...validation.controlProps("email")}
					name="email"
					type="email"
					value={values.email}
					onChange={update("email")}
					autoComplete="email"
					disabled={pending}
				/>
				<FieldError {...validation.errorProps("email")} />
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={validation.fieldId("message")}>Message</Label>
				<Textarea
					{...validation.controlProps("message")}
					name="message"
					value={values.message}
					onChange={update("message")}
					className="min-h-28"
					disabled={pending}
				/>
				<FieldError {...validation.errorProps("message")} />
			</div>

			{/*
			 * Honeypot — hidden from people and from assistive technology. The
			 * name and label are deliberately meaningless: browsers and password
			 * managers ignore `autoComplete="off"` and fill fields that look like
			 * a URL or company, and a filled honeypot drops the inquiry.
			 */}
			<div
				aria-hidden="true"
				className="absolute -left-[9999px] h-0 w-0 overflow-hidden"
			>
				<label htmlFor={honeypotId}>Leave this field empty</label>
				<input
					id={honeypotId}
					name="bfr_trap"
					type="text"
					tabIndex={-1}
					autoComplete="off"
					data-1p-ignore
					data-lpignore="true"
					value={website}
					onChange={(event) => setWebsite(event.target.value)}
				/>
			</div>

			<FormError
				message={
					submit.isError
						? "Your inquiry could not be sent. Please try again, or call us."
						: null
				}
			/>

			<Button type="submit" size="lg" className="w-full" disabled={pending}>
				{pending ? "Sending…" : "Submit inquiry"}
			</Button>
		</form>
	);
}
