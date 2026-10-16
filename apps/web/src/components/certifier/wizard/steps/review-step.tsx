"use client";

import { useQuery } from "@tanstack/react-query";

import { trpc } from "@/utils/trpc";

import { TestDocument } from "../../test-document";
import { usePhotoUrls } from "../use-photo-urls";
import type { WizardFormState } from "../wizard-shell";

/**
 * The last screen before Submit, laid out as the test form itself — the
 * document the purveyor and the customer will receive — so a certifier reads
 * exactly what is about to be filed. It is a preview, not a step: the
 * wizard is finished by the time it shows, so nothing on it links back to an
 * earlier screen — the certifier submits it or saves it to Drafts.
 */
export function ReviewStep({
	form,
	wpName,
	wpAddress,
	wpPwsid,
	waterPurveyorId,
}: {
	form: WizardFormState;
	wpName: string;
	wpAddress: string | null;
	wpPwsid: string | null;
	waterPurveyorId: string;
}) {
	const profile = useQuery(trpc.certifier.getProfile.queryOptions());
	const photoUrls = usePhotoUrls(form.id, waterPurveyorId, form.photoPaths);

	return (
		<TestDocument
			wp={{ name: wpName, address: wpAddress, pwsid: wpPwsid }}
			bfaType={form.bfaType}
			bin={form.bfaAssetId ? form.bin : form.submittedBinText || "No BIN"}
			wizardData={form.wizardData}
			customerName={form.customerName}
			customerEmail={form.customerEmail}
			testDate={form.testDate}
			signatureMethod={form.signatureMethod}
			signatureData={form.signatureData}
			photoPaths={form.photoPaths}
			photoUrls={photoUrls}
			certifier={profile.data ?? null}
			unsignedLabel="Not signed yet."
		/>
	);
}
