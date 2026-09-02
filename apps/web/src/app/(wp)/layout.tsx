import { WpShell } from "@/components/shell/wp-shell";

export default function WpLayout({ children }: { children: React.ReactNode }) {
	return <WpShell>{children}</WpShell>;
}
