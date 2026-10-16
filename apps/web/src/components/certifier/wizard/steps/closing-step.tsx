"use client";

import {
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS,
	PHOTO_ACCEPT,
	PHOTO_REJECTION_MESSAGES,
} from "@bfa-platform/api/lib/photo-rules";
import { Button } from "@bfa-platform/ui/components/button";
import { Card, CardContent } from "@bfa-platform/ui/components/card";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import { FieldError } from "@bfa-platform/ui/components/field-message";
import { Input } from "@bfa-platform/ui/components/input";
import { SignaturePad } from "@bfa-platform/ui/components/signature-pad";
import { Textarea } from "@bfa-platform/ui/components/textarea";
import { cn } from "@bfa-platform/ui/lib/utils";
import { isoToUsDate, usDateToIso } from "@bfa-platform/ui/lib/validation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { trpc } from "@/utils/trpc";

import { PhotoThumbnail } from "../photo-thumbnail";
import { preparePhoto } from "../prepare-photo";
import { SignOffButtons } from "../test-blocks/choice-buttons";
import { usePhotoUrls } from "../use-photo-urls";
import { WizardField } from "../wizard-field";
import type { WizardFormState } from "../wizard-shell";
import type { WizardValues } from "../wizard-types";

/**
 * Step 4 — the closing block (build-plan § 6.5 steps 18–19, in the sheet's order): comments, water
 * customer, optional photos, the owner's sign-off and the test date —
 * a signature by default, the checkbox bypass only when the owner is not
 * present.
 */
export function ClosingStep({
	form,
	waterPurveyorId,
	onAnswer,
	onField,
	onCustomer,
}: {
	form: WizardFormState;
	waterPurveyorId: string;
	onAnswer: (key: string, value: WizardValues[string]) => void;
	onField: <Key extends keyof WizardFormState>(
		key: Key,
		value: WizardFormState[Key],
	) => void;
	onCustomer: (field: "customerName" | "customerEmail", value: string) => void;
}) {
	const commentsId = useId();
	const dateId = useId();

	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<WizardField id={commentsId} label="Comments (optional)">
					{(id) => (
						<Textarea
							id={id}
							value={(form.wizardData.comments as string) ?? ""}
							onChange={(event) => onAnswer("comments", event.target.value)}
						/>
					)}
				</WizardField>

				<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
					<WizardField
						label="Customer name (optional)"
						fieldKey="customerName"
						flagged={
							form.prefilledKeys.has("customerName") &&
							form.overriddenFields.has("customerName")
						}
					>
						{(id) => (
							<Input
								id={id}
								value={form.customerName}
								onChange={(event) =>
									onCustomer("customerName", event.target.value)
								}
							/>
						)}
					</WizardField>
					<WizardField
						label="Customer email (optional)"
						fieldKey="customerEmail"
						flagged={
							form.prefilledKeys.has("customerEmail") &&
							form.overriddenFields.has("customerEmail")
						}
					>
						{(id) => (
							<Input
								id={id}
								type="email"
								value={form.customerEmail}
								onChange={(event) =>
									onCustomer("customerEmail", event.target.value)
								}
							/>
						)}
					</WizardField>
				</div>

				<PhotoUpload
					draftId={form.id}
					waterPurveyorId={waterPurveyorId}
					photoPaths={form.photoPaths}
					onChange={(paths) => onField("photoPaths", paths)}
				/>

				<SignOff form={form} onField={onField} />

				<WizardField id={dateId} label="Test date" required fieldKey="testDate">
					{(id) => (
						<DateInput
							id={id}
							pickerLabel="Choose test date"
							value={isoToUsDate(form.testDate)}
							onValueChange={(value) =>
								onField("testDate", usDateToIso(value) ?? "")
							}
						/>
					)}
				</WizardField>
			</CardContent>
		</Card>
	);
}

export function PhotoUpload({
	draftId,
	waterPurveyorId,
	photoPaths,
	onChange,
}: {
	draftId: string | undefined;
	waterPurveyorId: string;
	photoPaths: string[];
	onChange: (paths: string[]) => void;
}) {
	const inputId = useId();
	const errorId = useId();
	const [uploading, setUploading] = useState(false);
	// Why the last picked file was refused before any upload started.
	const [rejection, setRejection] = useState<string | null>(null);
	// Object URLs of the photos uploaded this session, for the thumbnails; a
	// resumed draft has none and waits for signed links.
	const [previews, setPreviews] = useState<Record<string, string>>({});
	// The same map for the unmount clean-up below, which must see the latest.
	const previewsRef = useRef(previews);
	previewsRef.current = previews;
	// Set for the whole of one upload. `uploading` disables the input too, but
	// a state flag only lands on the next render; a second pick arriving before
	// it would start a parallel upload from the same `photoPaths`.
	const busy = useRef(false);
	const queryClient = useQueryClient();
	// The stored photos of a resumed draft have no local file to preview; the
	// server signs a link for them.
	const urls = usePhotoUrls(draftId, waterPurveyorId, photoPaths);
	const getUploadUrl = useMutation(
		trpc.certifierWizard.getPhotoUploadUrl.mutationOptions(),
	);

	// Each preview pins its whole file in memory until revoked, so leaving the
	// step (to the review, or out of the wizard) releases them all.
	useEffect(
		() => () => {
			for (const url of Object.values(previewsRef.current)) {
				URL.revokeObjectURL(url);
			}
		},
		[],
	);

	// A slot's key can be reused once its old photo is pruned, so a signed link
	// cached for that path may be for the photo that was there before.
	function forgetSignedLinks() {
		queryClient.invalidateQueries(
			trpc.certifierWizard.getPhotoUrls.pathFilter(),
		);
	}

	async function handleFile(file: File) {
		if (!draftId) {
			toast.error("Save this test to draft once before adding a photo");
			return;
		}
		if (busy.current || photoPaths.length >= MAX_PHOTOS) return;

		busy.current = true;
		setUploading(true);
		try {
			// Checked — and a HEIC converted to JPEG — before an upload URL is
			// asked for or a byte is sent. The server and the bucket hold the
			// same rules again; this is the one that can say why in words.
			const photo = await preparePhoto(file);
			if (!photo.ok) {
				setRejection(PHOTO_REJECTION_MESSAGES[photo.reason]);
				return;
			}
			setRejection(null);

			const { token, path } = await getUploadUrl.mutateAsync({
				id: draftId,
				waterPurveyorId,
				extension: photo.extension,
				contentType: photo.contentType,
				size: photo.size,
				keep: photoPaths,
			});

			const { error } = await createClient()
				.storage.from("test-photos")
				.uploadToSignedUrl(path, token, photo.body);

			if (error) throw error;

			// Every format gets a local preview; `PhotoThumbnail` falls back to a
			// tile if this browser cannot draw it (an unconverted HEIC in Chrome).
			setPreviews((current) => ({
				...current,
				[path]: URL.createObjectURL(photo.body),
			}));
			onChange([...photoPaths, path]);
			forgetSignedLinks();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not upload that photo",
			);
		} finally {
			busy.current = false;
			setUploading(false);
		}
	}

	return (
		<WizardField
			label={`Photos (optional, up to ${MAX_PHOTOS})`}
			hint={`HEIC, PNG or JPG/JPEG, up to ${MAX_PHOTO_SIZE_LABEL} each.`}
		>
			{() => (
				<div className="flex flex-col gap-2">
					<div className="grid grid-cols-2 gap-3">
						{photoPaths.map((path, index) => (
							<div
								key={path}
								className="relative flex h-32 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"
							>
								<PhotoThumbnail
									path={path}
									src={previews[path] ?? urls[path]}
									alt={`Attached ${index + 1} of ${MAX_PHOTOS}`}
									pendingLabel={`Photo ${index + 1} added`}
									imageClassName="size-full object-cover"
								/>
								<Button
									type="button"
									variant="secondary"
									size="icon-xs"
									aria-label={`Remove photo ${index + 1}`}
									className="absolute top-1.5 right-1.5 rounded-full shadow-sm"
									onClick={() => {
										const preview = previews[path];
										if (preview) URL.revokeObjectURL(preview);
										setPreviews(({ [path]: _removed, ...rest }) => rest);
										onChange(
											photoPaths.filter((existing) => existing !== path),
										);
										forgetSignedLinks();
									}}
								>
									<X aria-hidden="true" />
								</Button>
							</div>
						))}

						{photoPaths.length < MAX_PHOTOS ? (
							// A label around a visually hidden input: the whole tile is the tap
							// target, and the browser's own "Choose file" control never shows.
							<label
								htmlFor={inputId}
								className={cn(
									"flex h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-border border-dashed bg-card text-[13px] text-muted-foreground transition-colors focus-within:ring-2 focus-within:ring-ring/40 hover:bg-muted",
									uploading && "pointer-events-none opacity-60",
								)}
							>
								{uploading ? (
									<LoaderCircle
										className="size-6 animate-spin"
										aria-hidden="true"
									/>
								) : (
									<Camera className="size-6" aria-hidden="true" />
								)}
								<span className="font-semibold text-foreground">
									{uploading ? "Uploading…" : "Add photo"}
								</span>
								<input
									id={inputId}
									type="file"
									accept={PHOTO_ACCEPT}
									className="sr-only"
									disabled={uploading}
									aria-describedby={rejection ? errorId : undefined}
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (file) handleFile(file);
										event.target.value = "";
									}}
								/>
							</label>
						) : null}
					</div>
					<FieldError id={errorId} message={rejection} />
				</div>
			)}
		</WizardField>
	);
}

function SignOff({
	form,
	onField,
}: {
	form: WizardFormState;
	onField: <Key extends keyof WizardFormState>(
		key: Key,
		value: WizardFormState[Key],
	) => void;
}) {
	const methodId = useId();

	return (
		<div className="flex flex-col gap-3 border-border border-t pt-4">
			<WizardField id={methodId} label="Sign-off" required fieldKey="signature">
				{() => (
					<SignOffButtons
						label="Sign-off"
						value={form.signatureMethod}
						onValueChange={(value) => onField("signatureMethod", value)}
					/>
				)}
			</WizardField>

			{form.signatureMethod === "signed" ? (
				<SignaturePad
					value={form.signatureData}
					onChange={(dataUrl) => onField("signatureData", dataUrl)}
					onClear={() => onField("signatureData", null)}
				/>
			) : form.signatureMethod === "owner_absent" ? (
				<p className="rounded-md bg-muted px-3 py-2 text-[13px] text-muted-foreground">
					Owner was not present - I certify under penalty of law and regulatory
					compliance guidelines that the assembly test values recorded above are
					true and accurate. The property manager was not present to sign the
					physical digital screen at the time of service.
				</p>
			) : null}
		</div>
	);
}
