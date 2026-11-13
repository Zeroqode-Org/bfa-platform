import type { Metadata } from "next";

import {
	LegalDocument,
	type LegalSection,
} from "@/components/landing/legal-document";

export const metadata: Metadata = {
	title: "Privacy Policy — Backflow Reporter.io",
	description: "Privacy Policy for BackFlowReporter.io.",
};

/**
 * Privacy Policy. Public, linked from the landing page footer. The text is the
 * client's, from "BACP PP and ToS" (effective October 8, 2026). The source's
 * bracketed citation markers ("[1, 2]") are left out — they point nowhere.
 */
export default function PrivacyPage() {
	return (
		<LegalDocument
			title="Privacy Policy"
			effectiveDate="October 8, 2026"
			intro={INTRO}
			sections={SECTIONS}
		/>
	);
}

const INTRO = [
	"BackFlowReporter.io (“Company”, “We”, “Us”, or “Our”) operates as a cloud-based software-as-a-service compliance platform engineered for public water systems, municipal utility boards, and regulatory water purveyors (“Water Purveyors” or “Client”). This Privacy Policy details the strict administrative, technical, and physical safeguards deployed to govern the ingestion, processing, isolation, and security of information within the Platform.",
	"This policy is designed to satisfy public sector data protection requirements, including cybersecurity guidelines, database isolation frameworks, and federal compliance standards such as the National Institute of Standards and Technology (NIST) Special Publication 800-53.",
];

const SECTIONS: LegalSection[] = [
	{
		title: "Section 1: System Classification and Scope of Data",
		clauses: [
			{
				number: "1.1",
				heading: "Role as Data Processor",
				text: "The Client utility acts as the primary Data Owner and Controller. BackFlowReporter.io operates strictly as a Data Processor. We ingest and maintain regulatory datasets solely to fulfill our contractual obligations as outlined in the enterprise procurement contract.",
			},
			{
				number: "1.2",
				heading: "Categories of Data Collected",
				text: "The Platform collects the following specific data elements to maintain your cross-connection control registry:",
				items: [
					{
						label: "Administrative & Profile Information",
						text: "Full names, institutional email addresses, and contact parameters of authorized utility sub-administrators, supervisors, and internal personnel.",
					},
					{
						label: "Physical Asset Footprints",
						text: "Backflow Identification Numbers (BINs), device serial numbers, manufacturer makes, device models, sizes, installation physical addresses, and hazard classification tiers.",
					},
					{
						label: "Field Engineering Metrics",
						text: "Hydraulic differential pressure values, pass/fail results, test dates, and licensing data submitted by certified third-party technicians using the field test wizard.",
					},
					{
						label: "Pure System Tracking Metrics",
						text: "Real-time log telemetry, database row interaction summaries, automatic notice run timestamps, and validation failure records.",
					},
				],
			},
		],
	},
	{
		title: "Section 2: Data Isolation and Logical Vault Boundaries",
		clauses: [
			{
				number: "2.1",
				heading: "Strict Multi-Tenancy",
				text: "The Platform hosts municipal customers on a shared infrastructure layer. To eliminate vendor friction and protect public data integrity, absolute data isolation is permanently enforced at the database architecture core.",
			},
			{
				number: "2.2",
				heading: "Server-Side Row-Level Security (RLS)",
				text: "Every asset profile, field reading, or background notification record written to our database is permanently stamped with a unique customer parameter. Database-enforced Row-Level Security (RLS) policies prevent cross-tenant data visibility. Your records are visible exclusively to Your authenticated personnel and authorized platform engineers.",
			},
			{
				number: "2.3",
				heading: "Zero Cross-Contamination Guarantee",
				text: "Data fields, active telemetry feeds, and customer history files managed within Your private vault are structurally isolated. It is physically impossible for another registered water purveyor account to view, query, scan, or access data belonging to Your network.",
			},
		],
	},
	{
		title: "Section 3: Use of Data and Automated Alerts",
		clauses: [
			{
				number: "3.1",
				heading: "Authorized Operational Utilization",
				text: "Company uses ingested data solely to keep the utility running smoothly. This includes:",
				items: [
					{
						text: "Updating your private dashboard with instant, system-wide asset status changes.",
					},
					{
						text: "Processing field readings submitted via our mobile-first entry tool.",
					},
					{
						text: "Compiling unalterable historical audit logs to ensure your records remain ready for regulatory audits.",
					},
				],
			},
			{
				number: "3.2",
				heading: "Hands-Off Enforcement Automation",
				text: "Our background engine continuously tracks device timelines behind the scenes to automate compliance monitoring. The system automatically compiles and dispatches professional notification alerts to property owners at sixty (60), forty-five (45), and thirty (30) days out from delinquency deadlines, reducing manual administrative workloads.",
			},
			{
				number: "3.3",
				heading: "No Commercial Exploitation",
				text: "BackFlowReporter.io does not engage in tracking monetization. We will never sell, lease, rent, trade, or share municipal records, system usage statistics, or user contact metrics with third-party advertising brokers or commercial entities.",
			},
		],
	},
	{
		title: "Section 4: Data Retention, Sovereignty, and Disposal",
		clauses: [
			{
				number: "4.1",
				heading: "Absolute Customer Sovereignty",
				text: "The purchasing Water Purveyor maintains complete legal ownership over all raw compliance logs, facility registers, and physical asset histories written to their private vault.",
			},
			{
				number: "4.2",
				heading: "Data Compilation Upon Contract Close",
				text: "Upon the lawful termination of your service subscription, BackFlowReporter.io will compile all records, device timelines, and historical logs contained within Your isolated vault into clean CSV or structured database files, delivering them directly to the Client to ensure unbroken tracking history.",
			},
			{
				number: "4.3",
				heading: "Certified Data Erasure",
				text: "Following verification that the exported data files have been successfully received and validated by the Client utility, Company will completely erase the corresponding rows inside the database environment within ninety (90) days, safely purging all residual assets from active server systems.",
			},
		],
	},
	{
		title: "Section 5: Cybersecurity Safeguards and Infrastructure Boundaries",
		clauses: [
			{
				number: "5.1",
				heading: "Advanced Cryptographic Protections",
				text: "All data passing through the Platform is secured using industry-standard transport layer security (TLS 1.3) during transit. Data-at-rest within the relational PostgreSQL cluster is encrypted utilizing FIPS-compliant AES-256 cryptographic standards.",
			},
			{
				number: "5.2",
				heading: "Threat Isolation Profiles",
				text: "Access to the global platform infrastructure is tightly managed using a strict, multi-tier environmental security structure. Production databases, super-admin command dashboards, and testing sandboxes operate inside isolated virtual environments, protected by advanced firewalls and continuous intrusion-detection monitors.",
			},
			{
				number: "5.3",
				heading: "Minimization of Data-at-Rest",
				text: "Our field submission wizard is engineered to use minimization principles. It acts as a real-time ingestion tunnel that validates data at the point of entry and updates your command center instantly, avoiding unnecessary file caching or temporary database data drift.",
			},
		],
	},
	{
		title: "Section 6: Compliance Status and Audit Log Retention",
		clauses: [
			{
				number: "6.1",
				heading: "Unalterable Historical Ledgers",
				text: "Every background process execution, automated alert delivery, administrative log modification, and field entry submission is recorded in a secure tracking ledger. This ledger logs the timestamp, action category, and profile token of the actor, providing an immutable master timeline for regulatory audits.",
			},
			{
				number: "6.2",
				heading: "System Usage Logs",
				text: "Analytics generated to track monthly software usage (such as total entries processed or alerts sent) are strictly operational and contain no identifiable private data.",
			},
		],
	},
	{
		title: "Section 7: Policy Amendments and Revisions",
		clauses: [
			{
				number: "7.1",
				heading: "Government Notification Procedures",
				text: "As a platform serving government utilities, BackFlowReporter.io will not make quiet or retrospective changes to data handling procedures. Any updates to this Privacy Policy will be delivered directly to your registered primary administrative contacts via electronic mail at least thirty (30) days prior to taking effect.",
			},
		],
	},
	{
		title: "Section 8: Primary Contact Node",
		clauses: [
			{
				number: "8.1",
				heading: "Systems Architect Office",
				text: "For technical questions about data security boundaries, database validation rules, row-level isolation policies, or to request systemic data audits, please contact our automation architecture team directly at: info@backflowreporter.io.",
			},
		],
	},
];
