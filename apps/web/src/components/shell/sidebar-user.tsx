import { cn } from "@bfa-platform/ui/lib/utils";

import type { Account } from "@/lib/auth";
import { roleLabel } from "@/lib/role-label";

/**
 * "Who am I signed in as", in the sidebar footer above Log out.
 *
 * Every shell looks identical across roles and tenants, so without this block
 * the only way to tell one account from another is to sign out and back in.
 * It answers the three questions that distinguish two sessions: the person,
 * the address they signed in with, and the role that decides what the screens
 * behind it will let them do.
 *
 * The email is shown even when a name exists — `profiles.full_name` is not
 * unique and, on seeded or test tenants, frequently is not filled in at all,
 * so the address is the field that actually identifies the session.
 */
export function SidebarUser({
	account,
	className,
}: {
	account: Account;
	className?: string;
}) {
	const name = account.fullName?.trim() || account.email || "Signed in";
	const email = account.email;

	return (
		<div className={cn("flex items-center gap-2.5 px-2 py-1.5", className)}>
			<span
				aria-hidden="true"
				className="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-semibold text-[11px] text-accent-foreground"
			>
				{initialsFor(name)}
			</span>
			<span className="flex min-w-0 flex-col">
				<span className="truncate font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
					{roleLabel(account.globalRole)}
				</span>
				<span
					className="truncate font-semibold text-[13px] text-foreground"
					title={name}
				>
					{name}
				</span>
				{email && email !== name ? (
					<span
						className="truncate text-[11px] text-muted-foreground"
						title={email}
					>
						{email}
					</span>
				) : null}
			</span>
		</div>
	);
}

/**
 * Up to two letters: the first letter of the first two words of a name, or the
 * first two characters of an email's local part when there is no name to take
 * them from.
 */
function initialsFor(name: string) {
	const words = name.split(/[\s@._-]+/).filter(Boolean);
	const letters = words.slice(0, 2).map((word) => word[0]);
	return (letters.join("") || name.slice(0, 2)).toUpperCase();
}
