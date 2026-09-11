"use client";

import { AUTOMATED_NOTICE_VARIABLES } from "@bfa-platform/api/lib/notice-variables";
import { Badge } from "@bfa-platform/ui/components/badge";
import { Button } from "@bfa-platform/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@bfa-platform/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@bfa-platform/ui/components/empty";
import { Input } from "@bfa-platform/ui/components/input";
import { Label } from "@bfa-platform/ui/components/label";
import { Skeleton } from "@bfa-platform/ui/components/skeleton";
import { Textarea } from "@bfa-platform/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

import {
	ComposerError,
	READ_ONLY_NOTICE,
	TemplatePreview,
	useVariableInsertion,
	VariableReferencePanel,
} from "./notice-composer";
import type { NoticeSampleValues } from "./notice-types";

/** Fallback sample values, until `getNoticePreviewSample` answers. */
const PENDING_SAMPLE: NoticeSampleValues = Object.fromEntries(
	AUTOMATED_NOTICE_VARIABLES.map((variable) => [variable.key, variable.sample]),
) as NoticeSampleValues;

/**
 * The four automated notice templates, and the editor for whichever one is
 * selected.
 *
 * One list and one editor, rendered from the server's own list, rather than
 * four field groups written out four times: the types come from the database
 * enum, and a fifth one would appear here without a line of this file changing.
 *
 * A template nobody has customized is not an empty state. The list always has
 * four entries and each one carries text — the purveyor's where they wrote it,
 * the platform's where they did not — so the editor opens on something
 * sendable and `isCustomized` is the only difference between the two cases.
 *
 * There is no enable/disable switch, deliberately. Automated notices are
 * switched on per purveyor by the Super-Admin; a per-type toggle would be a
 * control with undefined behaviour until what disabling a middle step means for
 * the escalation chain is answered.
 */
export function NoticeTemplatesEditor({ canEdit }: { canEdit: boolean }) {
	const queryClient = useQueryClient();
	const subjectId = useId();
	const bodyId = useId();

	const templates = useQuery(trpc.notices.listNoticeTemplates.queryOptions());
	const previewSample = useQuery(
		trpc.notices.getNoticePreviewSample.queryOptions(),
	);

	const [selectedType, setSelectedType] = useState<string | null>(null);
	/**
	 * Unsaved edits, one entry per notice type, and only for the types that have
	 * been typed into.
	 *
	 * Keyed rather than a single draft that an effect resets on selection, for
	 * two reasons. Switching tabs and coming back keeps what was typed, rather
	 * than silently discarding it. And there is no effect to get wrong: the
	 * editor's value is derived from this map with the server's row as the
	 * fallback, so a refetch cannot overwrite half a sentence and a save cannot
	 * leave the field showing stale text.
	 */
	const [edits, setEdits] = useState<
		Record<string, { subject: string; body: string }>
	>({});

	const rows = templates.data;
	const selected =
		rows?.find((row) => row.noticeType === selectedType) ?? rows?.[0] ?? null;
	const draft = selected
		? (edits[selected.noticeType] ?? {
				subject: selected.subject,
				body: selected.body,
			})
		: null;

	/** Writes an edit for the selected type, leaving the other three alone. */
	function editSelected(next: { subject: string; body: string }) {
		if (!selected) return;
		setEdits((current) => ({ ...current, [selected.noticeType]: next }));
	}

	/** Drops the edit, so the field falls back to whatever the server holds. */
	function clearEdit(noticeType: string) {
		setEdits((current) => {
			const { [noticeType]: _dropped, ...rest } = current;
			return rest;
		});
	}

	const saveTemplate = useMutation(
		trpc.notices.upsertNoticeTemplate.mutationOptions({
			onSuccess: async (row) => {
				toast.success(`${row.label} saved`);
				// Cleared before the refetch lands: the saved text is now the server's
				// answer, and an edit left in the map would shadow it forever.
				clearEdit(row.noticeType);
				await queryClient.invalidateQueries({
					queryKey: trpc.notices.listNoticeTemplates.queryKey(),
				});
			},
			// No toast on failure: the form shows the server's message inline, next
			// to the text the person still has to correct.
		}),
	);

	const insertion = useVariableInsertion({
		onInsertSubject: (subject) => {
			if (draft) editSelected({ ...draft, subject });
		},
		onInsertBody: (body) => {
			if (draft) editSelected({ ...draft, body });
		},
	});

	if (templates.isPending) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Notice templates</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					<Skeleton className="h-9 w-full rounded-md" />
					<Skeleton className="h-24 w-full rounded-md" />
					<Skeleton className="h-40 w-full rounded-md" />
				</CardContent>
			</Card>
		);
	}

	if (templates.isError) {
		return (
			<Card>
				<CardContent>
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<TriangleAlert className="text-danger" />
							</EmptyMedia>
							<EmptyTitle>Couldn&rsquo;t load notice templates</EmptyTitle>
							<EmptyDescription>{templates.error.message}</EmptyDescription>
						</EmptyHeader>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => templates.refetch()}
						>
							Try again
						</Button>
					</Empty>
				</CardContent>
			</Card>
		);
	}

	const saving = saveTemplate.isPending;
	const values = previewSample.data?.values ?? PENDING_SAMPLE;
	const unchanged =
		!!selected &&
		!!draft &&
		draft.subject === selected.subject &&
		draft.body === selected.body;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Notice templates</CardTitle>
				<CardDescription>
					The subject and message for each automated notice. A template you
					haven&rsquo;t written yet uses the platform default, so nothing sends
					blank.
				</CardDescription>
			</CardHeader>

			<CardContent className="flex flex-col gap-4">
				{/* One tab per type, rendered from the server's list. */}
				<div
					role="tablist"
					aria-label="Notice types"
					className="flex flex-wrap gap-1.5"
				>
					{templates.data.map((template) => {
						const active = template.noticeType === selected?.noticeType;

						return (
							<Button
								key={template.noticeType}
								type="button"
								role="tab"
								aria-selected={active}
								variant={active ? "default" : "outline"}
								size="sm"
								onClick={() => setSelectedType(template.noticeType)}
							>
								{template.label}
								{template.isCustomized ? null : (
									<span
										aria-hidden="true"
										className="text-[10px] opacity-70"
										title="Using the platform default"
									>
										•
									</span>
								)}
							</Button>
						);
					})}
				</div>

				{selected && draft ? (
					<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
						<div className="flex min-w-0 flex-1 flex-col gap-3">
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="font-bold text-[15.5px] text-foreground">
									{selected.label}
								</h3>
								{selected.isCustomized ? (
									<Badge variant="success">Customized</Badge>
								) : (
									<Badge variant="neutral">Platform default</Badge>
								)}
							</div>

							<p className="text-[12px] text-muted-foreground">
								{selected.isCustomized
									? "Your own text. Saving replaces it."
									: "Nobody has written this one yet — you are editing the platform default. Saving makes it yours."}
							</p>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor={subjectId}>Subject</Label>
								<Input
									id={subjectId}
									ref={insertion.subjectRef}
									name="subject"
									value={draft.subject}
									disabled={!canEdit || saving}
									onFocus={insertion.onSubjectFocus}
									onChange={(event) =>
										editSelected({ ...draft, subject: event.target.value })
									}
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor={bodyId}>Message</Label>
								<Textarea
									id={bodyId}
									ref={insertion.bodyRef}
									name="body"
									rows={12}
									className="min-h-56 font-normal text-[13px]"
									value={draft.body}
									disabled={!canEdit || saving}
									onFocus={insertion.onBodyFocus}
									onChange={(event) =>
										editSelected({ ...draft, body: event.target.value })
									}
								/>
							</div>

							<VariableReferencePanel
								variables={AUTOMATED_NOTICE_VARIABLES}
								disabled={!canEdit || saving}
								onInsert={insertion.insert}
							/>

							{saveTemplate.isError ? (
								<ComposerError message={saveTemplate.error.message} />
							) : null}

							{canEdit ? (
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										disabled={saving || unchanged}
										onClick={() =>
											saveTemplate.mutate({
												noticeType: selected.noticeType,
												subject: draft.subject,
												body: draft.body,
											})
										}
									>
										{saving ? "Saving…" : "Save template"}
									</Button>
									<Button
										type="button"
										variant="secondary"
										disabled={saving || unchanged}
										onClick={() => clearEdit(selected.noticeType)}
									>
										Discard changes
									</Button>
									{/* Restores the platform's text into the editor. It is not a
									    delete: saving is still what writes anything. */}
									<Button
										type="button"
										variant="ghost"
										disabled={saving}
										onClick={() =>
											editSelected({
												subject: selected.defaultSubject,
												body: selected.defaultBody,
											})
										}
									>
										Reset to platform default
									</Button>
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
								variables={AUTOMATED_NOTICE_VARIABLES}
							/>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
