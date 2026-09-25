"use client";

import { Button } from "@bfa-platform/ui/components/button";
import { Card, CardContent } from "@bfa-platform/ui/components/card";
import { DateInput } from "@bfa-platform/ui/components/date-input";
import { Input } from "@bfa-platform/ui/components/input";
import { SignaturePad } from "@bfa-platform/ui/components/signature-pad";
import { Textarea } from "@bfa-platform/ui/components/textarea";
import { cn } from "@bfa-platform/ui/lib/utils";
import { isoToUsDate, usDateToIso } from "@bfa-platform/ui/lib/validation";
import { useMutation } from "@tanstack/react-query";
import { Camera, ImageIcon, LoaderCircle, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { trpc } from "@/utils/trpc";

import { SignOffButtons } from "../test-blocks/choice-buttons";
import { usePhotoUrls } from "../use-photo-urls";
import { WizardField } from "../wizard-field";
import type { WizardFormState } from "../wizard-shell";
import type { WizardValues } from "../wizard-types";

const MAX_PHOTOS = 2;

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

function PhotoUpload({
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
	const [uploading, setUploading] = useState(false);
	// Object URLs of the files chosen this session, for the thumbnails; a
	// resumed draft has none, and shows a plain "Photo 1 added" tile instead.
	const [previews, setPreviews] = useState<Record<string, string>>({});
	// The stored photos of a resumed draft have no local file to preview; the
	// server signs a link for them.
	const urls = usePhotoUrls(draftId, waterPurveyorId, photoPaths);
	const getUploadUrl = useMutation(
		trpc.certifierWizard.getPhotoUploadUrl.mutationOptions(),
	);

	async function handleFile(file: File) {
		if (!draftId) {
			toast.error("Save this test to draft once before adding a photo");
			return;
		}
		if (photoPaths.length >= MAX_PHOTOS) return;

		setUploading(true);
		try {
			const { token, path } = await getUploadUrl.mutateAsync({
				id: draftId,
				waterPurveyorId,
			});

			const { error } = await createClient()
				.storage.from("test-photos")
				.uploadToSignedUrl(path, token, file);

			if (error) throw error;

			setPreviews((current) => ({
				...current,
				[path]: URL.createObjectURL(file),
			}));
			onChange([...photoPaths, path]);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not upload that photo",
			);
		} finally {
			setUploading(false);
		}
	}

	return (
		<WizardField label={`Photos (optional, up to ${MAX_PHOTOS})`}>
			{() => (
				<div className="grid grid-cols-2 gap-3">
					{photoPaths.map((path, index) => (
						<div
							key={path}
							className="relative flex h-32 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"
						>
							{(previews[path] ?? urls[path]) ? (
								// biome-ignore lint/performance/noImgElement: a blob: URL of the file just chosen, not an asset Next can optimise
								<img
									src={previews[path] ?? urls[path]}
									alt={`Attached ${index + 1} of ${MAX_PHOTOS}`}
									className="size-full object-cover"
								/>
							) : (
								<span className="flex flex-col items-center gap-1 text-[12px] text-muted-foreground">
									<ImageIcon className="size-5" aria-hidden="true" />
									Photo {index + 1} added
								</span>
							)}
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
									onChange(photoPaths.filter((existing) => existing !== path));
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
								accept="image/*"
								// Opens the camera straight away on a phone; ignored on desktop.
								capture="environment"
								className="sr-only"
								disabled={uploading}
								onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) handleFile(file);
									event.target.value = "";
								}}
							/>
						</label>
					) : null}
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
