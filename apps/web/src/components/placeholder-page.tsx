import { PageTitle } from "@bfa-platform/ui/components/page-title";

/**
 * On-brand stub for a route whose real screen hasn't been built yet. Every
 * scaffolded `page.tsx` renders one of these so the route slot is visible in
 * the shell and reads as deliberate, not broken.
 */
export function PlaceholderPage({
	title,
	route,
}: {
	title: string;
	route: string;
}) {
	return (
		<div className="flex flex-col gap-6">
			<PageTitle>{title}</PageTitle>

			<div className="flex flex-col items-center gap-3 rounded-lg border border-border-soft border-dashed bg-card px-6 py-16 text-center">
				<span className="grid size-10 place-items-center rounded-lg bg-accent text-primary">
					<svg
						viewBox="0 0 24 24"
						className="size-5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" />
						<path d="M4 10h16M10 10v10" />
					</svg>
				</span>
				<p className="font-semibold text-foreground text-sm">In progress</p>
				<p className="max-w-xs text-[13px] text-muted-foreground leading-relaxed">
					This screen isn&rsquo;t built yet. The shell and route are wired up so
					it can drop straight in.
				</p>
				<code className="mt-1 rounded bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground">
					{route}
				</code>
			</div>
		</div>
	);
}
