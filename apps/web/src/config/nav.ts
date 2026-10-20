import {
	Building2,
	ClipboardList,
	FileClock,
	FilePlus2,
	FileText,
	Home,
	type LucideIcon,
	Mail,
	User,
	UserCheck,
	Users,
	Wrench,
} from "lucide-react";
import type { Route } from "next";

export type NavItem = {
	href: Route;
	label: string;
	icon: LucideIcon;
};

/** The three role shells, each with its own nav set. */
export type NavVariant = "certifier" | "wp" | "admin";

/**
 * Certifier dashboard navigation. Build-plan §"Certifier dashboard" lists four
 * entries — Wizard, Drafts, Submitted Tests, Log Out. "Log Out" is an action in
 * the shell footer, not a route; Profile rounds out the tab set (sidebar on
 * desktop, bottom tab bar on mobile).
 */
export const certifierNav: NavItem[] = [
	{ href: "/certifier/wizard", label: "Wizard", icon: FilePlus2 },
	{ href: "/certifier/drafts", label: "Drafts", icon: FileText },
	{ href: "/certifier/submitted", label: "Submitted Tests", icon: FileClock },
	{ href: "/certifier/profile", label: "Profile", icon: User },
];

/** Water Purveyor dashboard — order matches the approved prototype sidebar. */
export const wpNav: NavItem[] = [
	{ href: "/wp", label: "Home", icon: Home },
	{ href: "/wp/assets", label: "BFA Assets", icon: ClipboardList },
	{ href: "/wp/certifiers", label: "Certifiers", icon: UserCheck },
	{ href: "/wp/customers", label: "Customers", icon: Users },
	{ href: "/wp/repair-companies", label: "Repair Companies", icon: Wrench },
	{ href: "/wp/tests", label: "Submitted Tests", icon: FileText },
	{ href: "/wp/notices", label: "Notices & Email", icon: Mail },
];

/** Super-Admin — cross-tenant view. More entries land with the Week 4 wiring pass. */
export const adminNav: NavItem[] = [
	{ href: "/admin", label: "Water Purveyors", icon: Building2 },
];

/** Nav set per role shell — read by both `SidebarNav` and `BottomTabBar`. */
export const navByVariant: Record<NavVariant, NavItem[]> = {
	certifier: certifierNav,
	wp: wpNav,
	admin: adminNav,
};
