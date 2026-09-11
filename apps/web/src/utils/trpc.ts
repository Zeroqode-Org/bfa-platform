import type { AppRouter } from "@bfa-platform/api/routers/index";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { toast } from "sonner";

import { signInNoticeRedirectFor } from "@/lib/sign-in-notice";

/**
 * Sends the browser to the sign-in screen when a request comes back refused
 * because the account behind it is no longer usable, and reports whether it
 * did.
 *
 * The route gates cover a page load. This is the other half: a certifier
 * already sitting on a screen when a water purveyor blocks them. Their next
 * query or mutation is refused, and without this they would get a toast on a
 * page that still looks signed in.
 *
 * A full navigation rather than the router, deliberately. It runs the server
 * gate, throws away a React Query cache full of data the person may no longer
 * be entitled to, and clears the router cache that would otherwise keep
 * serving already-rendered segments.
 *
 * `redirecting` guards the batch case: a screen with several queries in flight
 * gets several refusals, and each one would otherwise start its own navigation.
 */
let redirecting = false;

function redirectIfRefused(error: unknown): boolean {
	const route = signInNoticeRedirectFor(error);

	if (!route) return false;
	if (redirecting) return true;

	redirecting = true;
	window.location.assign(route);

	return true;
}

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error, query) => {
			// A refusal is not something to offer a retry for — retrying is exactly
			// what will not help.
			if (redirectIfRefused(error)) return;

			toast.error(error.message, {
				action: {
					label: "retry",
					onClick: () => {
						query.invalidate();
					},
				},
			});
		},
	}),
	mutationCache: new MutationCache({
		// Only the redirect. Mutations report their own failures where the person
		// was working — inline on a form, or as a toast — and this must not take
		// that over for the ordinary errors.
		onError: (error) => {
			redirectIfRefused(error);
		},
	}),
});

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: "/api/trpc",
		}),
	],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
	client: trpcClient,
	queryClient,
});
