import { PageTitle } from "@bfa-platform/ui/components/page-title";
import {
	Building2,
	ChevronRight,
	Droplets,
	FlaskConical,
	type LucideIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

const roles: {
	href: Route;
	label: string;
	description: string;
	icon: LucideIcon;
}[] = [
	{
		href: "/admin",
		label: "Super Admin",
		description: "Manage every water purveyor on the platform.",
		icon: Building2,
	},
	{
		href: "/wp",
		label: "Water Purveyor",
		description: "Track incoming and delinquent backflow tests.",
		icon: Droplets,
	},
	{
		href: "/certifier/wizard",
		label: "Certifier",
		description: "Run test wizards and submit results from the field.",
		icon: FlaskConical,
	},
];

export default function RolePicker() {
	return (
		<main className="min-h-svh bg-background px-6 pt-24 pb-16 sm:px-10 lg:px-16 lg:pt-32">
			<div className="mx-auto w-full max-w-4xl">
				<div className="mb-2.5 flex items-center gap-2.5">
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
							<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
						</svg>
					</span>
					<span className="font-bold text-[13px] text-foreground tracking-tight">
						Backflow Assembly
					</span>
				</div>

				<PageTitle kicker="Select a workspace">
					Where are you working today?
				</PageTitle>
				<p className="mt-2 max-w-md text-[13px] text-muted-foreground leading-relaxed">
					Development shortcut — after sign-in each user lands in their own
					workspace automatically.
				</p>

				<div className="mt-8 grid gap-4 sm:grid-cols-3">
					{roles.map(({ href, label, description, icon: Icon }) => (
						<Link
							key={href}
							href={href}
							className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)] transition-all hover:-translate-y-0.5 hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<span className="grid size-11 place-items-center rounded-lg bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
								<Icon className="size-5" strokeWidth={1.75} />
							</span>
							<span className="font-bold text-[15px] text-foreground">
								{label}
							</span>
							<span className="flex-1 text-[13px] text-muted-foreground leading-relaxed">
								{description}
							</span>
							<span className="inline-flex items-center gap-1 font-semibold text-[13px] text-primary">
								Enter
								<ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
							</span>
						</Link>
					))}
				</div>
			</div>
		</main>
	);
}
