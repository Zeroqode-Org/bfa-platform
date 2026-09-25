import { Document, Image, Page, Text, View } from "@react-pdf/renderer";

import {
	ASSEMBLY_FIELD_KEYS,
	BFA_TYPE_NAMES,
	INITIAL_TEST_KEY,
	ISOLATES_PROPERTY_KEY,
	PHOTO_PATH_KEYS,
} from "../wizard-input";
import { pdfStyles, textValue } from "./pdf-styles";
import { Cell, Check, Table } from "./test-blocks";

export type ResultDocumentAsset = {
	bin: string;
	serviceAddress: string;
	make: string | null;
	model: string | null;
	serialNumber: string | null;
	size: string | null;
	assemblyLocation: string | null;
} | null;

export type ResultDocumentWp = {
	companyName: string;
	address: string | null;
	pwsid: string | null;
};

export type ResultDocumentCertifier = {
	fullName: string | null;
	company: string | null;
	idNumber: string | null;
};

export type ResultDocumentSubmission = {
	id: string;
	bfaType: "RP" | "RPDA" | "RPDA-2" | "DC" | "DCDA" | "DCDA-2" | "PVB" | "SVB";
	submittedBinText: string | null;
	testDate: string | null;
	testResult: "pass" | "fail" | null;
	signatureMethod: "signed" | "owner_absent" | null;
	signatureData: string | null;
};

/** A bordered block of the form with its heading. */
function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<View style={pdfStyles.section} wrap={false}>
			<Text style={pdfStyles.sectionTitle}>{title}</Text>
			{children}
		</View>
	);
}

function dateLabel(iso: string | null): string {
	if (!iso) return "—";
	const [year, month, day] = iso.split("-");

	return year && month && day ? `${month}/${day}/${year}` : "—";
}

/**
 * The results document — one PDF per submitted test, laid out as the same form
 * the certifier reviewed on screen before submitting (build-plan § 6.5 step
 * 22): the purveyor and form title on top, then bordered sections — assembly,
 * customer, the type's own initial test, property isolation, the result,
 * comment, certification and the owner's signature.
 *
 * The purveyor and certifier blocks are pulled from the database and passed in
 * as plain data — never from wizard input — so a certifier's own typed values
 * can never rewrite who they are or who they work for on the record. The test
 * section arrives as `testBlock`, built per type from `WIZARD_TEST_SPEC`.
 */
export function ResultDocument({
	title,
	submission,
	wp,
	certifier,
	asset,
	customerName,
	customerEmail,
	wizardData,
	photos,
	testBlock,
}: {
	/** The PDF's own title, shown by viewers in their tab and title bar. */
	title: string;
	submission: ResultDocumentSubmission;
	wp: ResultDocumentWp;
	certifier: ResultDocumentCertifier;
	asset: ResultDocumentAsset;
	customerName: string;
	customerEmail: string;
	wizardData: Record<string, unknown>;
	/** The attached photos, already fetched, drawn under the signature. */
	photos: { data: Buffer; format: "jpg" | "png" }[];
	testBlock: React.ReactNode;
}) {
	// `wizard_data`'s own copy is the record of what was actually filed —
	// present whether the BIN resolved or not — and takes precedence over the
	// linked asset's live columns, which may have moved on since this test.
	const field = (key: string, fallback: string | null | undefined) =>
		textValue(wizardData[key] ?? fallback);
	const isolates = wizardData[ISOLATES_PROPERTY_KEY];
	const result = wizardData[INITIAL_TEST_KEY];
	const attachments = PHOTO_PATH_KEYS.filter((key) => wizardData[key]).length;
	const typeName = BFA_TYPE_NAMES[submission.bfaType];

	return (
		<Document
			title={title}
			author={wp.companyName}
			subject="Backflow assembly test"
		>
			<Page size="LETTER" style={pdfStyles.page}>
				<View style={pdfStyles.frame}>
					<View style={pdfStyles.header}>
						<View>
							<Text style={pdfStyles.wpName}>{wp.companyName}</Text>
							{wp.address ? (
								<Text style={pdfStyles.muted}>{wp.address}</Text>
							) : null}
							{wp.pwsid ? (
								<Text style={pdfStyles.muted}>PWSID {wp.pwsid}</Text>
							) : null}
						</View>
						<View>
							<Text style={pdfStyles.formTitle}>
								BACKFLOW PREVENTION ASSEMBLY TEST FORM
							</Text>
							<Text style={pdfStyles.pill}>
								{submission.bfaType} Assembly – Initial Test
							</Text>
						</View>
					</View>

					<Section title="Assembly information">
						<Table>
							<Cell
								label="BIN"
								value={asset?.bin ?? textValue(submission.submittedBinText)}
							/>
							<Cell
								label="Service address"
								value={field(
									ASSEMBLY_FIELD_KEYS.serviceAddress,
									asset?.serviceAddress,
								)}
							/>
						</Table>
						<Table>
							<Cell
								label="Make"
								value={field(ASSEMBLY_FIELD_KEYS.make, asset?.make)}
							/>
							<Cell
								label="Model"
								value={field(ASSEMBLY_FIELD_KEYS.model, asset?.model)}
							/>
							<Cell
								label="Serial no."
								value={field(
									ASSEMBLY_FIELD_KEYS.serialNumber,
									asset?.serialNumber,
								)}
							/>
							<Cell
								label="Size"
								value={field(ASSEMBLY_FIELD_KEYS.size, asset?.size)}
							/>
						</Table>
						<Table>
							<Cell
								label="Assembly type"
								value={`${submission.bfaType} — ${typeName}`}
							/>
							<Cell
								label="Assembly location"
								value={field(
									ASSEMBLY_FIELD_KEYS.location,
									asset?.assemblyLocation,
								)}
							/>
						</Table>
					</Section>

					<Section title="Customer information">
						<Table>
							<Cell label="Customer name" value={textValue(customerName)} />
							<Cell label="Customer email" value={textValue(customerEmail)} />
						</Table>
					</Section>

					<Section title={`Initial test — ${typeName}`}>{testBlock}</Section>

					<Section title="Property isolation">
						<View style={pdfStyles.checks}>
							<Text style={{ fontSize: 8.5 }}>
								Does this assembly isolate the entire property?
							</Text>
							<Check checked={isolates === "yes"} label="Yes" />
							<Check checked={isolates === "no"} label="No" />
							<Check
								checked={isolates === "undetermined"}
								label="Undetermined"
							/>
						</View>
					</Section>

					<Section title="Initial test result">
						<View style={pdfStyles.tiles}>
							<View
								style={[
									pdfStyles.tile,
									result === "pass" ? pdfStyles.tilePass : {},
									{ marginRight: 6 },
								]}
							>
								<Text style={pdfStyles.tileText}>PASS</Text>
							</View>
							<View
								style={[
									pdfStyles.tile,
									result === "fail" ? pdfStyles.tileFail : {},
								]}
							>
								<Text style={pdfStyles.tileText}>FAIL</Text>
							</View>
						</View>
					</Section>

					<Section title="Comment">
						<Text style={pdfStyles.comment}>
							{typeof wizardData.comments === "string"
								? wizardData.comments
								: ""}
						</Text>
					</Section>

					<Section title="Certification">
						<Table>
							<Cell
								label="Initial test by"
								value={textValue(certifier.fullName)}
							/>
							<Cell
								label="Certifier tester no."
								value={textValue(certifier.idNumber)}
							/>
							<Cell label="Company" value={textValue(certifier.company)} />
						</Table>
						<Table>
							<Cell
								label="Initial test date"
								value={dateLabel(submission.testDate)}
							/>
							<Cell label="Assembly type" value={submission.bfaType} />
							<Cell label="Customer" value={textValue(customerName)} />
						</Table>
					</Section>

					<Section title="Assembly owner signature">
						{submission.signatureMethod === "owner_absent" ? (
							<Text style={pdfStyles.disclaimer}>
								{submission.signatureData}
							</Text>
						) : submission.signatureData ? (
							<Image
								src={submission.signatureData}
								style={{ height: 44, width: 140 }}
							/>
						) : (
							<Text style={pdfStyles.muted}>Not signed.</Text>
						)}
						{photos.length > 0 ? (
							<View style={pdfStyles.photos}>
								{photos.map((photo, index) => (
									<Image
										// biome-ignore lint/suspicious/noArrayIndexKey: at most two, in a fixed order
										key={index}
										src={{ data: photo.data, format: photo.format }}
										style={pdfStyles.photo}
									/>
								))}
							</View>
						) : null}
						<Text style={[pdfStyles.muted, { marginTop: 4 }]}>
							{attachments} {attachments === 1 ? "attachment" : "attachments"}
						</Text>
					</Section>

					<Text style={pdfStyles.footer}>
						Form generated by Backflow wizard
					</Text>
				</View>
			</Page>
		</Document>
	);
}
