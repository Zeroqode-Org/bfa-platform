import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";

import "../index.css";
import Providers from "@/components/providers";

const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
	display: "swap",
});

const sora = Sora({
	variable: "--font-sora",
	subsets: ["latin"],
	weight: ["600", "700"],
	display: "swap",
});

export const metadata: Metadata = {
	title: "Backflow Assembly",
	description:
		"Backflow assembly test tracking for water purveyors and certifiers",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			{/*
			 * suppressHydrationWarning: browser extensions (Grammarly, password
			 * managers) inject attributes into <body> before React hydrates, which
			 * React otherwise reports as a mismatch. It applies one level deep — to
			 * this element's own attributes only — so real mismatches inside the app
			 * are still reported.
			 */}
			<body
				suppressHydrationWarning
				className={`${inter.variable} ${sora.variable} font-sans antialiased`}
			>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
