export function TopHeader({
	title,
	kicker,
	action,
}: {
	title: string;
	kicker?: string;
	action?: React.ReactNode;
}) {
	return (
		<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-border border-b bg-card px-7">
			<div className="flex min-w-0 flex-col">
				{kicker ? (
					<span className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
						{kicker}
					</span>
				) : null}
				<span className="truncate font-semibold text-foreground text-sm">
					{title}
				</span>
			</div>
			{action ? <div className="flex items-center gap-2">{action}</div> : null}
		</header>
	);
}
