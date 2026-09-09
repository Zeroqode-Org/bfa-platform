import { redirect } from "next/navigation";

import { requireCaller } from "@/lib/auth";
import { landingRouteFor } from "@/lib/landing-route";

/**
 * The front door. Renders nothing — it resolves who the caller is and sends
 * them to their own dashboard.
 *
 * This replaces the workspace picker, which let anyone walk into any of the
 * three shells. It was a development shortcut from before roles were resolved
 * server-side; now that they are, asking people which role they are is both
 * pointless and misleading, since the sections enforce the answer anyway.
 *
 * The route itself stays, rather than being deleted: it is where the sign-in
 * screen sends people, what the sidebar logo links to, and the one place that
 * knows a role without being told one.
 */
export default async function Home() {
	const caller = await requireCaller();

	redirect(landingRouteFor(caller.globalRole));
}
