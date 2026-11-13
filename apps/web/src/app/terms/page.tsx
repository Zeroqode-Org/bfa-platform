import type { Metadata } from "next";

import {
	LegalDocument,
	type LegalSection,
} from "@/components/landing/legal-document";

export const metadata: Metadata = {
	title: "Terms of Service — Backflow Reporter.io",
	description: "Terms of Service for BackFlowReporter.io.",
};

/**
 * Terms of Service. Public, linked from the landing page footer. The text is
 * the client's, from "BACP PP and ToS" (effective October 8, 2026).
 */
export default function TermsPage() {
	return (
		<LegalDocument
			title="Terms of Service"
			effectiveDate="October 8, 2026"
			intro={INTRO}
			sections={SECTIONS}
		/>
	);
}

const INTRO = [
	"This Terms of Service Agreement (“Agreement”) constitutes a legally binding contractual covenant entered into by and between BackFlowReporter.io (“Company”, “We”, “Us”, or “Our”) and the purchasing public water system, municipal board, utility district, or contracting governmental entity (“Water Purveyor”, “Client”, or “You”). By executing a procurement order, accessing the platform, or authorizing administrative employee credentials, You agree to adhere to all stipulations, conditions, and provisions set forth herein.",
];

const SECTIONS: LegalSection[] = [
	{
		title: "Section 1: Regulatory Alignment and Purpose of Platform",
		clauses: [
			{
				number: "1.1",
				heading: "Platform Scope",
				text: "BackFlowReporter.io delivers a secure, multi-tenant cloud software-as-a-service tracking environment (“Platform”) built around an asset-centric data paradigm. The Platform is engineered to assist Water Purveyors in monitoring, enforcing, and organizing public cross-connection control data pipelines, structural assembly logs, and historical hydraulic metrics.",
			},
			{
				number: "1.2",
				heading: "Account Provisioning",
				text: "Access to the Platform command interfaces is granted strictly on an enterprise subscription basis, subject to verified municipal procurement agreements and public entity authorization parameters.",
			},
			{
				number: "1.3",
				heading: "Local Ordinance Sovereignty",
				text: "The Client acknowledges that the Platform serves as an administrative monitoring tool. The legal authority to enforce compliance directives, manage certification deadlines, and execute structural water shut-off procedures remains under the sole jurisdiction of the local governing Water Purveyor.",
			},
		],
	},
	{
		title: "Section 2: System Up-Time and Service Accessibility",
		clauses: [
			{
				number: "2.1",
				heading: "Continuous Service Standard",
				text: "The Platform operates as a dedicated digital compliance assistant, functioning twenty-four (24) hours a day, seven (7) days a week, three hundred sixty-five (365) days a year (24/7/365).",
			},
			{
				number: "2.2",
				heading: "Maintenance Windows",
				text: "Company reserves the right to perform scheduled system upgrades, core optimization cycles, or server-side structural patches. Company will make reasonable commercial efforts to schedule maintenance during off-peak hours (12:00 AM to 4:00 AM Standard Local Time) and will issue digital notifications to Client sub-administrators at least forty-eight (48) hours prior to execution.",
			},
			{
				number: "2.3",
				heading: "Upstream Disruptions",
				text: "Company is not liable for service degradation, connection dropouts, or data stream transmission breaks caused by municipal internet failures, localized field communication issues, or upstream infrastructure dropouts originating from external hosting server clusters.",
			},
		],
	},
	{
		title: "Section 3: Role-Based Path Validation and Security Boundaries",
		clauses: [
			{
				number: "3.1",
				heading: "Authorization Profiles",
				text: "The Platform uses strict server-side Role-Based Access Control (RBAC) definitions to isolate system functionality. Client accounts are limited to verified personnel assigned the sub_admin profile token.",
			},
			{
				number: "3.2",
				heading: "Super-Admin Interface Isolation",
				text: "The Global Super-Admin Dashboard, SaaS Team Management interfaces, internal employee directories, and global tracking registries are structurally restricted to authorized internal Company personnel. Sub-administrators, Client workers, and field testers are blocked from viewing, entering, or query-routing into these master admin directories.",
			},
			{
				number: "3.3",
				heading: "Session Integrity Protection",
				text: "Any attempt by a Client account to bypass interface pathways, execute unauthorized script injections, deploy automated data scrapers, or manually input hidden super-admin URLs will trigger an instant, automated security lock down, terminating all open sessions associated with the offending user profile metadata.",
			},
		],
	},
	{
		title: "Section 4: Data Isolation and Mutual Tenant Vaults",
		clauses: [
			{
				number: "4.1",
				heading: "Multi-Tenant Separation",
				text: "The Platform hosts multiple utility customers on a shared hardware cluster. To ensure complete privacy, absolute data separation is permanently enforced at the database architecture layer using server-side Row-Level Security (RLS) policy barriers.",
			},
			{
				number: "4.2",
				heading: "Logical Vault Protections",
				text: "Every asset record, test completion, or notification log written to the database is stamped with a unique customer parameter. This data structure ensures Client records remain invisible to adjacent water purveyors. It is physically impossible for external utilities to view, parse, query, or compromise the data stored inside Your private account environment.",
			},
			{
				number: "4.3",
				heading: "No Cross-Contamination",
				text: "Company guarantees that the tracking data, active data feeds, and local compliance statuses managed inside Your workspace will never be combined, leaked, or exposed to outside organizations using the Platform.",
			},
		],
	},
	{
		title: "Section 5: Ownership of Proprietary Properties and Logs",
		clauses: [
			{
				number: "5.1",
				heading: "Proprietary Property Rights",
				text: "All system frameworks, layout models, mobile entry field wizards, input validation matrices, automated email messaging triggers, background execution engines, and software source codes are the exclusive intellectual property of BackFlowReporter.io. All property rights, titles, interests, and worldwide patents are reserved natively by Company.",
			},
			{
				number: "5.2",
				heading: "Customer Data Ownership",
				text: "The Client retains exclusive, unalterable legal ownership over all raw compliance logs, facility profiles, and physical device histories written to their private database vault during their subscription active timeline.",
			},
			{
				number: "5.3",
				heading: "Structural Database Layouts",
				text: "While You own the data entries written to Your vault, You gain no legal claim or copyright interest over the database schema definitions, tracking system columns, index configurations, or processing algorithms running on the platform server.",
			},
		],
	},
	{
		title: "Section 6: Automated Validation Gateways and Notification Loops",
		clauses: [
			{
				number: "6.1",
				heading: "Hard Input Boundaries",
				text: "The Platform deploys automated validation checks directly inside the mobile field wizard interface. If an external technician types a mathematical error or an invalid serial number at the job site, the software blocks the entry gate instantly. This data shield prevents messy field typos from writing to Your database, keeping Your records immaculate.",
			},
			{
				number: "6.2",
				heading: "Hands-Off Notice Schedules",
				text: "The 24/7/365 background machine engine autonomously calculates compliance timelines and dispatches professional notification alerts to property owners at sixty (60), forty-five (45), and thirty (30) days out from delinquency. Client administrators assume full responsibility for setting up, reviewing, and confirming the local notification dates chosen in their system workspace layout.",
			},
			{
				number: "6.3",
				heading: "Documentation Processing",
				text: "The Platform compiles historical records and formats data registries into print-ready sheets automatically. The Client remains responsible for pulling down these files and presenting them to state or regional compliance agencies as needed for localized reporting audits.",
			},
		],
	},
	{
		title: "Section 7: Transition and Retention Protocols",
		clauses: [
			{
				number: "7.1",
				heading: "Termination for Convenience",
				text: "Either party may terminate account access subject to sixty (60) days advance notice parameters documented inside the formal municipal procurement contract.",
			},
			{
				number: "7.2",
				heading: "Data Compilation on Exit",
				text: "Upon lawful termination of subscription accounts, Company will compile all records, physical asset timelines, and historical logs contained inside Your isolated vault into clean CSV or structured database files. These files will be delivered directly to the Client to ensure unbroken tracking history for local records.",
			},
			{
				number: "7.3",
				heading: "Final Data Erasure",
				text: "Following verification that the exported logs have been successfully downloaded by the Client utility, Company will completely erase the corresponding rows inside the tenant database vault within ninety (90) days to maintain clean system storage.",
			},
		],
	},
	{
		title: "Section 8: Indemnification and Warranty Limitations",
		clauses: [
			{
				number: "8.1",
				heading: "Software Delivered As-Is",
				text: "BackFlowReporter.io provides its cloud monitoring infrastructure on an “as-is” and “as-available” architectural blueprint. Company explicitly disclaims all implied warranties of fitness for a specific regional plumbing infrastructure or particular municipal health department criteria.",
			},
			{
				number: "8.2",
				heading: "Client Enforcement Liability",
				text: "The individual Client utility assumes absolute legal liability for ensuring backflow prevention assemblies (BFAs) are physically inspected on time by qualified personnel. Company bears zero operational liability for physical line cross-connections, contamination instances, system hardware failures, or regional plumbing accidents within Your distribution network.",
			},
			{
				number: "8.3",
				heading: "Indemnity Boundaries",
				text: "To the extent permitted by applicable municipal law, the Client agrees to hold harmless and protect BackFlowReporter.io against any third-party legal claims, environmental administrative penalties, or operational liabilities resulting from staff negligence, improper database configuration changes by local clerks, or fraudulent data submitted by field testing networks.",
			},
		],
	},
	{
		title: "Section 9: Governing Law and Severability",
		clauses: [
			{
				number: "9.1",
				heading: "Jurisdiction",
				text: "This Agreement shall be interpreted, construed, and enforced according to the laws of the jurisdiction where the Water Purveyor’s primary municipal headquarters resides.",
			},
			{
				number: "9.2",
				heading: "Severability Provision",
				text: "If any clause, provision, or subsection of these Terms is deemed invalid or unenforceable by a court of competent jurisdiction, that specific clause shall be removed from the text without affecting the legal validity and enforceability of the remaining provisions.",
			},
		],
	},
];
