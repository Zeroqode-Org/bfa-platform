"use client";

import { NOTICE_FIELD_LIMITS } from "@bfa-platform/api/lib/notice-field-limits";
import {
	BROADCAST_FILTER_DESCRIPTIONS,
	BROADCAST_FILTER_LABELS,
	BROADCAST_RECIPIENT_FILTERS,
	type BroadcastRecipientFilter,
} from "@bfa-platform/api/lib/notice-recipients";
import {
	BROADCAST_VARIABLES,
	templateTextError,
	variableKeys,
} from "@bfa-platform/api/lib/notice-variables";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@bfa-platform/ui/components/card";
import {
	FieldCounter,
	FieldError,
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
import { Textarea } from "@bfa-platform/ui/components/textarea";
import { useFormValidation } from "@bfa-platform/ui/hooks/use-form-validation";
import {
	composeRules,
	maxLength,
	required,
} from "@bfa-platform/ui/lib/validation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Users } from "lucide-react";
import { useState } from "react";

import { trpc } from "@/utils/trpc";

import {
	ComposerError,
	READ_ONLY_NOTICE,
	TemplatePreview,
	useVariableInsertion,
	VariableReferencePanel,
} from "./notice-composer";
import type { NoticeSampleValues } from "./notice-types";

const PENDING_SAMPLE: NoticeSampleValues = Object.fromEntries(
	BROADCAST_VARIABLES.map((variable) => [variable.key, variable.sample]),
) as NoticeSampleValues;

const BROADCAST_KEYS = variableKeys(BROADCAST_VARIABLES);

/**
 * The server's broadcast `templateText` rule, checked at the field: present,
 * within the limit, and using only the two recipient-scoped placeholders.
 */
function broadcastRule(label: string, max: number) {
	return composeRules(
		required(`${label} is required.`),
		maxLength(max),
		(value) => templateTextError(value, BROADCAST_KEYS) ?? undefined,
	);
}

const BROADCAST_RULES = {
	// Who a broadcast goes to is the most consequential answer on this card, so
	// it is never pre-chosen: an untouched select would otherwise mean "every
	// customer" without anybody having said so.
	recipientFilter: required("Select the recipients."),
	subject: broadcastRule("Subject", NOTICE_FIELD_LIMITS.subject),
	body: broadcastRule("Message", NOTICE_FIELD_LIMITS.body),
};

/**
 * The general-info broadcast: one message, composed now, sent now, to a named
 * audience.
 *
 * Not a template and not a notice. It does not touch `notice_templates`, there
 * is no scheduler behind it and nothing here keeps a history of what was sent —
 * all three are deliberately out of scope.
 *
 * Two variables, not six. A customer may own several assemblies, so `{{bin}}`
 * and the rest have no single value for a recipient; the panel offers the two
 * that do, and the server refuses the others rather than mailing a placeholder.
 *
 * The audience opens unchosen. Once one is chosen its count is shown before
 * anything is sent, from the same server predicate the send uses, so the number
 * on screen is the number of people who will receive this.
 */
export function GeneralInfoBroadcast({ canSend }: { canSend: boolean }) {
	const [recipientFilter, setRecipientFilter] = useState<
		BroadcastRecipientFilter | ""
	>("");
	const [draft, setDraft] = useState({ subject: "", body: "" });
	const [sentSummary, setSentSummary] = useState<string | null>(null);

	const validation = useFormValidation({
		values: { ...draft, recipientFilter },
		rules: BROADCAST_RULES,
	});
	const bodyCounterId = `${validation.fieldId("body")}-count`;

	// Nothing is counted until an audience is chosen, and the placeholder never
	// reaches the procedure: the query is disabled, so its input is never sent.
	const audience = useQuery({
		...trpc.notices.getBroadcastAudience.queryOptions({
			recipientFilter: recipientFilter || BROADCAST_RECIPIENT_FILTERS[0],
		}),
		enabled: recipientFilter !== "",
	});

	const sendBroadcast = useMutation(
		trpc.notices.sendGeneralInfoBroadcast.mutationOptions({
			onSuccess: (result) => {
				setSentSummary(
					`Sent to ${result.sentCount} ${result.sentCount === 1 ? "customer" : "customers"} — ${BROADCAST_FILTER_LABELS[result.recipientFilter]}.`,
				);
				// The composer clears: this is a one-off send, and leaving the text in
				// place invites the same message being sent twice.
				setDraft({ subject: "", body: "" });
				// A cleared composer is a fresh one, not a message missing its text.
				validation.reset();
			},
			// No toast: the result and any failure are reported inline, where the
			// person is looking.
		}),
	);

	const insertion = useVariableInsertion({
		onInsertSubject: (subject) =>
			setDraft((current) => ({ ...current, subject })),
		onInsertBody: (body) => setDraft((current) => ({ ...current, body })),
	});

	const sending = sendBroadcast.isPending;
	const chosen = recipientFilter !== "";
	const values = audience.data?.sampleValues ?? PENDING_SAMPLE;
	const recipientCount = audience.data?.recipientCount ?? 0;
	// Missing or invalid answers do not disable the button: pressing it says what
	// is wrong at the field. Only a chosen audience that cannot receive anything
	// does.
	const canSubmit =
		canSend &&
		!sending &&
		(!chosen || (audience.isSuccess && recipientCount > 0));

	return (
		<Card>
			<CardHeader>
				<CardTitle>General info broadcast</CardTitle>
				<CardDescription>
					A one-off message to a group of your customers. It is sent when you
					press send — there is no schedule and no draft kept.
				</CardDescription>
			</CardHeader>

			<CardContent className="flex flex-col gap-4 lg:flex-row lg:items-start">
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("recipientFilter")}>
							Recipients
						</Label>
						<Select
							items={BROADCAST_FILTER_LABELS}
							value={recipientFilter || null}
							disabled={!canSend || sending}
							onValueChange={(value) => {
								setRecipientFilter(
									(value ?? "") as BroadcastRecipientFilter | "",
								);
								setSentSummary(null);
							}}
						>
							<SelectTrigger
								{...validation.controlProps("recipientFilter")}
								name="recipientFilter"
							>
								<SelectValue placeholder={SELECT_PLACEHOLDER} />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{BROADCAST_RECIPIENT_FILTERS.map((filter) => (
										<SelectItem key={filter} value={filter}>
											{BROADCAST_FILTER_LABELS[filter]}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						<FieldError {...validation.errorProps("recipientFilter")} />
						{chosen ? (
							<p className="text-[12px] text-muted-foreground">
								{BROADCAST_FILTER_DESCRIPTIONS[recipientFilter]}
							</p>
						) : null}
					</div>

					{/* Who this reaches, before it reaches them. Same predicate as the
					    send, so the count cannot describe a different set. */}
					<p
						className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[13px] text-accent-foreground"
						aria-live="polite"
					>
						<Users className="size-4 shrink-0" aria-hidden="true" />
						{!chosen
							? "Choose the recipients to see how many customers this reaches."
							: audience.isPending
								? "Counting recipients…"
								: audience.isError
									? "Couldn't count the recipients for this audience."
									: `${BROADCAST_FILTER_LABELS[recipientFilter]} — ${recipientCount} ${recipientCount === 1 ? "recipient" : "recipients"}`}
					</p>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("subject")}>Subject</Label>
						<Input
							{...validation.controlProps("subject")}
							ref={insertion.subjectRef}
							name="subject"
							value={draft.subject}
							disabled={!canSend || sending}
							placeholder="Water main work next week"
							onFocus={insertion.onSubjectFocus}
							onChange={(event) =>
								setDraft({ ...draft, subject: event.target.value })
							}
						/>
						<FieldError {...validation.errorProps("subject")} />
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor={validation.fieldId("body")}>Message</Label>
						<Textarea
							{...validation.controlProps("body", {
								describedBy: bodyCounterId,
							})}
							ref={insertion.bodyRef}
							name="body"
							rows={10}
							className="min-h-44 text-[13px]"
							value={draft.body}
							disabled={!canSend || sending}
							placeholder="Hello {{customer_name}},"
							onFocus={insertion.onBodyFocus}
							onChange={(event) =>
								setDraft({ ...draft, body: event.target.value })
							}
						/>
						<FieldError {...validation.errorProps("body")} />
						<FieldCounter
							id={bodyCounterId}
							length={draft.body.trim().length}
							max={NOTICE_FIELD_LIMITS.body}
						/>
					</div>

					<VariableReferencePanel
						variables={BROADCAST_VARIABLES}
						disabled={!canSend || sending}
						onInsert={insertion.insert}
						description="Only values that are the same for every one of a customer's assemblies can be used here — a customer may own several."
					/>

					{sendBroadcast.isError ? (
						<ComposerError message={sendBroadcast.error.message} />
					) : null}

					{sentSummary ? (
						<p
							className="flex items-start gap-1.5 rounded-md bg-success-bg px-3 py-2 text-[13px] text-success"
							role="status"
						>
							<CheckCircle2
								className="mt-px size-4 shrink-0"
								aria-hidden="true"
							/>
							{sentSummary}
						</p>
					) : null}

					{canSend ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								disabled={!canSubmit}
								onClick={() => {
									setSentSummary(null);
									if (!validation.validate() || recipientFilter === "") return;

									sendBroadcast.mutate({ ...draft, recipientFilter });
								}}
							>
								{sending
									? "Sending…"
									: chosen
										? `Send to ${recipientCount} ${recipientCount === 1 ? "recipient" : "recipients"}`
										: "Send broadcast"}
							</Button>
							<span className="text-[12px] text-muted-foreground">
								Sends immediately. There is no undo.
							</span>
						</div>
					) : (
						<p className="text-[12px] text-muted-foreground">
							{READ_ONLY_NOTICE}
						</p>
					)}
				</div>

				<div className="flex w-full min-w-0 flex-col gap-2 lg:max-w-[380px]">
					<h3 className="font-bold text-[13px] text-foreground">Preview</h3>
					<TemplatePreview
						subject={draft.subject}
						body={draft.body}
						values={values}
						variables={BROADCAST_VARIABLES}
					/>
				</div>
			</CardContent>
		</Card>
	);
}
