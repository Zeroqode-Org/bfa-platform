import { Badge } from "@bfa-platform/ui/components/badge";
import {
	Activity,
	BarChart3,
	BatteryFull,
	ClipboardCheck,
	Droplet,
	LayoutDashboard,
	LockKeyhole,
	MailCheck,
	PhoneCall,
	ShieldCheck,
	Sparkles,
	TimerReset,
} from "lucide-react";

import { ContactForm } from "./contact-form";
import { SiteFooter, SiteHeader } from "./site-chrome";
import { TryItDialog } from "./try-it-dialog";

const CONTACT_PHONE = { display: "808.940.8463", href: "tel:+18089408463" };

/**
 * The public landing page, shown at `/` to anyone without a session.
 *
 * One page, replicated from the design the client approved (Flowstep export,
 * "BackflowReporter-Landing"). There is no sign-up: the header offers sign-in,
 * and "Try it out now" opens the contact form, because accounts are created by
 * invitation once the team has talked to the purveyor.
 */
export function LandingPage() {
	return (
		<div className="min-h-svh bg-background text-foreground">
			<SiteHeader sectionLinks />
			<main>
				<Hero />
				<TrustStrip />
				<Standards />
				<Contact />
			</main>
			<SiteFooter />
		</div>
	);
}

function Hero() {
	return (
		<section id="platform" className="scroll-mt-20 bg-accent/40">
			<div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-12 sm:px-8 lg:grid-cols-2 lg:py-14">
				<div className="max-w-2xl">
					<Badge
						variant="primary"
						className="mb-5 rounded-md px-3 py-1 font-medium text-xs uppercase tracking-wide"
					>
						Municipal &amp; Utility Compliance Engine
					</Badge>
					<h1 className="font-display font-semibold text-4xl leading-tight tracking-tight sm:text-5xl">
						Cross-Connection Control &amp; Backflow Tracking, Automated.
					</h1>
					<p className="mt-6 max-w-xl text-lg text-muted-foreground leading-8">
						The unified cloud platform built explicitly for water purveyors to
						track physical assets, accept digital test reports from certified
						field technicians, and eliminate administrative friction via
						autonomous customer email loops.
					</p>
					<div className="mt-8 flex flex-wrap items-center gap-4">
						<TryItDialog />
						<span className="text-muted-foreground text-sm">
							Built for public safety teams
						</span>
					</div>
				</div>
				<HeroMockup />
			</div>
		</section>
	);
}

/**
 * The product illustration: a dashboard card with the certifier's phone
 * overlapping its corner. Decorative — the same claims are in the copy — so it
 * is hidden from assistive technology. Below `sm` the phone is dropped and the
 * dashboard stands alone, since the overlap needs room it does not have.
 */
function HeroMockup() {
	return (
		<div aria-hidden="true" className="relative sm:min-h-[400px]">
			<div className="overflow-hidden rounded-xl border border-primary/30 bg-card shadow-lg sm:absolute sm:top-6 sm:left-0 sm:z-10 sm:w-[82%]">
				<div className="flex items-center justify-between bg-primary px-4 py-3 text-primary-foreground">
					<div className="flex items-center gap-2 font-semibold text-sm">
						<Droplet className="size-4" />
						BackflowReporter
					</div>
					<div className="flex items-center gap-2 text-xs opacity-80">
						<span className="size-2 rounded-full bg-primary-foreground" />
						District View Active Panel
					</div>
				</div>
				<div className="grid gap-4 p-4 sm:grid-cols-[1.35fr_0.65fr]">
					<div>
						<div className="mb-3 flex items-center justify-between gap-2">
							<div>
								<p className="text-muted-foreground text-xs">
									Dashboard / Providers
								</p>
								<p className="mt-1 font-semibold text-base">
									Asset Enrollment Tracking
								</p>
							</div>
							<span className="rounded-full bg-primary px-2 py-0.5 font-semibold text-[11px] text-primary-foreground">
								Live
							</span>
						</div>
						<div className="overflow-hidden rounded-lg border border-border">
							<div className="grid grid-cols-[1.4fr_0.6fr_0.9fr] bg-table-header-bg px-3 py-2 font-semibold text-[10px] text-muted-foreground uppercase tracking-wide">
								<span>Asset</span>
								<span>Type</span>
								<span>Status</span>
							</div>
							<MockRow
								asset="Oak Street Library"
								type="RP"
								status="Compliant"
							/>
							<MockRow asset="North Pump Station" type="DC" status="Due soon" />
							<MockRow
								asset="Harbor Medical"
								type="RP"
								status="In review"
								outline
							/>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-1">
						<div className="rounded-lg border border-border/80 p-4">
							<p className="text-muted-foreground text-xs">
								Annual Renewal Coverage
							</p>
							<p className="mt-1 font-semibold text-3xl">64%</p>
							<div className="mt-3 h-2 rounded-full bg-muted">
								<div className="h-2 w-2/3 rounded-full bg-primary" />
							</div>
						</div>
						<div className="rounded-lg border border-border/80 p-4">
							<div className="flex items-center justify-between">
								<p className="text-muted-foreground text-xs">Certified Tests</p>
								<BarChart3 className="size-4 text-primary" />
							</div>
							<div className="mt-3 flex h-12 items-end gap-2">
								<div className="h-5 w-3 rounded-t-sm bg-primary/30" />
								<div className="h-8 w-3 rounded-t-sm bg-primary/50" />
								<div className="h-10 w-3 rounded-t-sm bg-primary/70" />
								<div className="h-7 w-3 rounded-t-sm bg-primary" />
								<div className="h-11 w-3 rounded-t-sm bg-primary/80" />
							</div>
						</div>
					</div>
				</div>
			</div>

			<div className="absolute top-0 right-0 z-20 hidden w-40 overflow-hidden rounded-[2rem] border-4 border-primary/70 bg-card shadow-xl sm:block">
				<div className="flex items-center justify-between bg-primary px-3 py-2 text-[9px] text-primary-foreground">
					<span>9:41</span>
					<BatteryFull className="size-3" />
				</div>
				<div className="p-3">
					<div className="mb-3 flex items-center gap-1 font-semibold text-[9px]">
						<Droplet className="size-3 text-primary" />
						Certifier Portal
					</div>
					<p className="mb-3 font-semibold text-xs">Annual Test Visibility</p>
					{["Device / location", "Differential pressure", "Relief opening"].map(
						(field) => (
							<div
								key={field}
								className="mb-3 rounded-md border border-input p-2 text-[9px] text-muted-foreground"
							>
								{field}
							</div>
						),
					)}
					<div className="flex h-7 items-center justify-center rounded-md bg-primary text-[9px] text-primary-foreground">
						Submit Report
					</div>
				</div>
			</div>

			<div className="absolute right-1 bottom-2 z-30 hidden rounded-full border border-border bg-card px-3 py-2 font-medium text-xs shadow-sm sm:block">
				40% less admin time
			</div>
		</div>
	);
}

function MockRow({
	asset,
	type,
	status,
	outline = false,
}: {
	asset: string;
	type: string;
	status: string;
	outline?: boolean;
}) {
	return (
		<div className="grid grid-cols-[1.4fr_0.6fr_0.9fr] items-center gap-1 border-border border-t px-3 py-2 text-xs">
			<span>{asset}</span>
			<span>{type}</span>
			<span
				className={
					outline
						? "w-fit rounded-full border border-border px-2 py-0.5 text-[10px]"
						: "w-fit rounded-full bg-accent px-2 py-0.5 text-[10px] text-accent-foreground"
				}
			>
				{status}
			</span>
		</div>
	);
}

function TrustStrip() {
	const items = [
		{ icon: ShieldCheck, label: "Secure Database Architecture" },
		{ icon: ClipboardCheck, label: "USC Aligned Field Validation" },
		{ icon: LockKeyhole, label: "Enterprise-Grade Encryption" },
	];

	return (
		<div className="border-border border-y bg-card">
			<ul className="mx-auto flex max-w-7xl flex-col items-start gap-3 px-4 py-3 text-muted-foreground text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-12 sm:px-8">
				{items.map(({ icon: Icon, label }) => (
					<li key={label} className="flex items-center gap-2">
						<Icon className="size-4 text-primary" aria-hidden="true" />
						{label}
					</li>
				))}
			</ul>
		</div>
	);
}

function Standards() {
	const wizardPoints = [
		{
			icon: TimerReset,
			title: "60-Second Submissions:",
			body: "Technicians can flawlessly validate line pressures, check valves, and relief openings using an ultra-fast field form with built-in error protection.",
		},
		{
			icon: Sparkles,
			title: "No Training Required:",
			body: "Adaptive logic effortlessly guides testers through precise differential pressure inputs for all standard assemblies, including RP, DC, and PVB.",
		},
		{
			icon: Activity,
			title: "Live Compliance Metrics:",
			body: "Eliminates paper bottlenecks, immediately updates compliance statuses, and satisfies your core public safety tracking objectives.",
		},
	];

	return (
		<section
			id="standards"
			className="mx-auto grid max-w-7xl scroll-mt-20 gap-10 px-4 py-14 sm:px-8 lg:grid-cols-2 lg:gap-16 lg:py-16"
		>
			<div>
				<Badge variant="primary" className="rounded-md">
					Compliance &amp; Standards
				</Badge>
				<h2 className="mt-4 font-display font-semibold text-3xl tracking-tight">
					Engineered for Rigorous Standards
				</h2>
				<h3 className="mt-8 font-semibold text-xl">
					Built for USC Field Accuracy
				</h3>
				<p className="mt-3 max-w-xl text-muted-foreground leading-7">
					Our data entry wizard is explicitly optimized around the precise
					hydraulic testing metrics mandated by the USC Foundation for
					Cross-Connection Control 10th Edition manual. Technicians can validate
					check valves, line pressures, and relief openings flawlessly with
					real-time error prevention built into the field form.
				</p>
				<div className="mt-8 rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
					<p className="font-medium text-lg">Seamless Data Entry Wizard</p>
					<ul className="mt-4 flex flex-col gap-4">
						{wizardPoints.map(({ icon: Icon, title, body }) => (
							<li key={title} className="flex gap-3">
								<Icon
									className="mt-0.5 size-5 shrink-0 text-primary"
									aria-hidden="true"
								/>
								<p className="text-sm leading-6">
									<span className="font-semibold">{title}</span> {body}
								</p>
							</li>
						))}
					</ul>
				</div>
			</div>

			<div className="rounded-2xl bg-accent/40 p-6 sm:p-8">
				<h2 className="font-display font-semibold text-3xl tracking-tight">
					Ready for Your AWWA M14 Administration Goals
				</h2>
				<p className="mt-5 text-muted-foreground leading-7">
					Running a broader municipal program? While our field forms prioritize
					USC testing metrics, BackflowReporter’s database tracking, automated
					email loops, and real-time dashboard are built to satisfy the core
					record-keeping, enforcement, and public safety tracking
					recommendations outlined in the AWWA M14 manual.
				</p>
				<div className="mt-8 grid gap-4 sm:grid-cols-2">
					<FeatureCard
						icon={MailCheck}
						title="Automated outreach"
						body="Keep owners informed without manual follow-up."
					/>
					<FeatureCard
						icon={LayoutDashboard}
						title="Real-time visibility"
						body="See every asset, test, and exception in one place."
					/>
				</div>
			</div>
		</section>
	);
}

function FeatureCard({
	icon: Icon,
	title,
	body,
}: {
	icon: typeof MailCheck;
	title: string;
	body: string;
}) {
	return (
		<div className="rounded-xl border border-border bg-card p-5">
			<Icon className="size-5 text-primary" aria-hidden="true" />
			<p className="mt-4 font-semibold">{title}</p>
			<p className="mt-2 text-muted-foreground text-sm">{body}</p>
		</div>
	);
}

function Contact() {
	return (
		<section
			id="contact"
			className="scroll-mt-20 border-border border-t bg-accent/20"
		>
			<div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
				<div className="flex flex-col justify-between gap-8">
					<div>
						<p className="font-semibold text-primary text-sm uppercase tracking-wider">
							Have questions?
						</p>
						<h2 className="mt-3 font-display font-semibold text-4xl tracking-tight">
							Let’s make compliance easier.
						</h2>
						<p className="mt-5 max-w-md text-muted-foreground leading-7">
							Talk with our team about your district, tester network, and
							administration goals.
						</p>
					</div>
					<a
						href={CONTACT_PHONE.href}
						className="flex w-fit items-center gap-3 font-medium text-lg transition-colors hover:text-primary"
					>
						<PhoneCall className="size-5 text-primary" aria-hidden="true" />
						{CONTACT_PHONE.display}
					</a>
				</div>
				<div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)] sm:p-7">
					<h3 className="font-display font-semibold text-2xl">Contact Us</h3>
					<p className="mt-1 mb-6 text-muted-foreground text-sm">
						Tell us a little about your program.
					</p>
					<ContactForm />
				</div>
			</div>
		</section>
	);
}
