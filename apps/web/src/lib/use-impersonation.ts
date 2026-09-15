"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { hardNavigate } from "@/lib/hard-navigate";
import { trpc } from "@/utils/trpc";

/**
 * Super-Admin impersonation, backed by the server.
 *
 * There is no client-side impersonation state any more. Whether somebody is
 * impersonating is decided on the server, from a signed `httpOnly` cookie the
 * browser cannot read, and reaches the page through `requireAccount` — the
 * shell hands it to the banner. These hooks only ask the server to change it
 * and then reload the application into the new identity.
 */

/**
 * What the banner needs to know, as resolved by the server route gate. Null
 * whenever the signed-in account is acting as itself.
 */
export type ImpersonationState = {
	waterPurveyorName: string;
};

/**
 * Starts impersonating the purveyor behind a WP list row. On success the
 * browser does a full load of `/wp`, so the route gate and every query run as
 * the purveyor's admin from the first request.
 *
 * `isPending || isSuccess` is what a caller should treat as "busy": between the
 * mutation settling and the navigation replacing the page there is a moment
 * where a second click would otherwise be accepted.
 */
export function useStartImpersonation() {
	return useMutation(
		trpc.superAdmin.startImpersonation.mutationOptions({
			onSuccess: () => hardNavigate("/wp"),
			// The query cache toasts its own errors; mutations do not.
			onError: (error) => toast.error(error.message),
		}),
	);
}

/**
 * Ends the impersonation and reloads into the Super-Admin's own list. A failure
 * leaves the banner where it is — it has no other way to go away.
 */
export function useEndImpersonation() {
	return useMutation(
		trpc.superAdmin.endImpersonation.mutationOptions({
			onSuccess: () => hardNavigate("/admin"),
			onError: (error) => toast.error(error.message),
		}),
	);
}
