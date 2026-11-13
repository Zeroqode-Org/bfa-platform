import { SiteFooter, SiteHeader } from "./site-chrome";

/**
 * One numbered clause: "1.1 Role as Data Processor. The Client utility…".
 * `items` renders as a bulleted list after the text, for clauses that
 * enumerate (the categories of data collected, the uses of data).
 */
export type LegalClause = {
	number: string;
	heading: string;
	text?: string;
	items?: { label?: string; text: string }[];
};

export type LegalSection = { title: string; clauses: LegalClause[] };

/**
 * The shell for the public legal pages — Terms of Service and Privacy Policy.
 * The text is the client's own, supplied as "BACP PP and ToS"; it lives as data
 * in each page so a revision is an edit to the text, not to the markup.
 */
export function LegalDocument({
	title,
	effectiveDate,
	intro,
	sections,
}: {
	title: string;
	effectiveDate: string;
	intro: string[];
	sections: LegalSection[];
}) {
	return (
		<div className="flex min-h-svh flex-col bg-background text-foreground">
			<SiteHeader sectionLinks={false} />
			<main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-8 sm:py-16">
				<h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
					{title}
				</h1>
				<p className="mt-3 text-muted-foreground text-sm">
					Effective Date: {effectiveDate}
				</p>

				<div className="mt-8 flex flex-col gap-4 text-[15px] text-muted-foreground leading-7">
					{intro.map((paragraph) => (
						<p key={paragraph}>{paragraph}</p>
					))}
				</div>

				<div className="mt-10 flex flex-col gap-10 text-[15px] leading-7">
					{sections.map((section) => (
						<section key={section.title}>
							<h2 className="mb-4 font-semibold text-foreground text-xl">
								{section.title}
							</h2>
							<div className="flex flex-col gap-4 text-muted-foreground">
								{section.clauses.map((clause) => (
									<div key={clause.number}>
										<p>
											<span className="font-semibold text-foreground">
												{clause.number} {clause.heading}.
											</span>
											{clause.text ? ` ${clause.text}` : null}
										</p>
										{clause.items ? (
											<ul className="mt-2 flex list-disc flex-col gap-1.5 pl-6">
												{clause.items.map((item) => (
													<li key={item.text}>
														{item.label ? (
															<span className="font-medium text-foreground">
																{item.label}:{" "}
															</span>
														) : null}
														{item.text}
													</li>
												))}
											</ul>
										) : null}
									</div>
								))}
							</div>
						</section>
					))}
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}
