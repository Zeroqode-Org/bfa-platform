import {
	inspectInvitation,
	redemptionMessage,
} from "@bfa-platform/api/lib/invitation-redemption";
import { Button } from "@bfa-platform/ui/components/button";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import { RedeemForm } from "@/components/invite/redeem-form";

/**
 * First-login screen.
 *
 * The token in the URL is a bearer credential, so this page must never be
 * cached or prerendered — `force-dynamic` keeps every request resolving the
 * invitation for itself.
 */
export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
	wp_admin: "Water Purveyor Administrator",
	wp_sub_admin: "Water Purveyor Sub-Administrator",
	wp_employee: "Water Purveyor Employee",
	certifier: "Certifier",
};

export default async function InvitePage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	const inspection = await inspectInvitation(decodeURIComponent(token));

	if (inspection.state !== "valid") {
		return (
			<InviteShell title="This invitation cannot be used">
				<p
					role="alert"
					className="mt-4 flex items-start gap-1.5 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					{redemptionMessage(inspection.state)}
				</p>

				<Button
					render={<Link href="/login">Go to sign in</Link>}
					variant="secondary"
					className="mt-5 w-full"
				/>
			</InviteShell>
		);
	}

	const { invitation, mode } = inspection;
	const roleLabel = ROLE_LABELS[invitation.role] ?? invitation.role;

	if (mode === "existing_certifier") {
		return (
			<InviteShell title="Add this water purveyor">
				<p className="mt-1.5 text-[13px] text-muted-foreground">
					{invitation.email} is already registered as a certifier, so there is
					no profile to fill in.{" "}
					{invitation.waterPurveyorName ?? "This water purveyor"} will appear in
					your purveyor selector as soon as you confirm.
				</p>

				<RedeemForm
					secret={decodeURIComponent(token)}
					mode="existing_certifier"
					isCertifier
				/>
			</InviteShell>
		);
	}

	return (
		<InviteShell title="Set up your account">
			<p className="mt-1.5 text-[13px] text-muted-foreground">
				You were invited as a {roleLabel}
				{invitation.waterPurveyorName
					? ` for ${invitation.waterPurveyorName}`
					: ""}
				. Your sign-in email is <strong>{invitation.email}</strong>.
			</p>

			{mode === "new_water_purveyor" ? (
				<p className="mt-1.5 text-[13px] text-muted-foreground">
					<strong>{invitation.waterPurveyorName}</strong> is created when you
					finish here, with you as its first administrator.
				</p>
			) : null}

			<RedeemForm
				secret={decodeURIComponent(token)}
				mode={mode}
				isCertifier={invitation.role === "certifier"}
			/>
		</InviteShell>
	);
}

/** Same branded card as the sign-in screen — this is the other front door. */
function InviteShell({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<main className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
			<div className="w-full max-w-[460px]">
				<div className="mb-5 flex items-center justify-center gap-2.5">
					<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
						<svg
							viewBox="0 0 24 24"
							className="size-4"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<title>Backflow Assembly</title>
							<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
						</svg>
					</span>
					<span className="font-bold text-[13px] text-foreground tracking-tight">
						Backflow Assembly
					</span>
				</div>

				<div className="rounded-xl border border-border bg-card p-7 shadow-[var(--shadow-card)]">
					<h1 className="font-bold font-display text-[20px] text-foreground leading-tight">
						{title}
					</h1>
					{children}
				</div>
			</div>
		</main>
	);
}
