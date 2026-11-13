import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LandingPage } from "@/components/landing/landing-page";
import { optionalAccount } from "@/lib/auth";
import { landingRouteFor } from "@/lib/landing-route";

export const metadata: Metadata = {
	title: "Backflow Reporter.io — Cross-connection control & backflow tracking",
	description:
		"The cloud platform for water purveyors to track backflow assemblies, accept digital test reports from certified testers, and automate customer notices.",
};

/**
 * The front door. A visitor without a session sees the public landing page; a
 * signed-in account is resolved and sent to its own dashboard, as before.
 *
 * The route stays the one place that knows a role without being told one: it
 * is where the sign-in screen sends people and what the sidebar logo links to.
 * There is no sign-up — accounts exist only through invitations — so the
 * landing page offers sign-in and a contact form, nothing more.
 */
export default async function Home() {
	const account = await optionalAccount();

	if (!account) return <LandingPage />;

	redirect(landingRouteFor(account.globalRole));
}
