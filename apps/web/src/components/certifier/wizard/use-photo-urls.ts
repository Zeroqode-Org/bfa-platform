"use client";

import { useQuery } from "@tanstack/react-query";

import { trpc } from "@/utils/trpc";

/**
 * Viewable links for a test's photos, keyed by their storage path. The photos
 * live in a private bucket the browser cannot read, so the server signs a
 * short-lived link for each; an empty map until they arrive (or when the test
 * has no draft yet, or no photos).
 */
export function usePhotoUrls(
	draftId: string | undefined,
	waterPurveyorId: string,
	paths: string[],
): Record<string, string> {
	const query = useQuery({
		...trpc.certifierWizard.getPhotoUrls.queryOptions({
			id: draftId ?? "",
			waterPurveyorId,
			paths,
		}),
		enabled: Boolean(draftId) && paths.length > 0,
		// Links live ten minutes; asking again on every screen would be wasted.
		staleTime: 5 * 60 * 1000,
	});

	return query.data ?? {};
}
