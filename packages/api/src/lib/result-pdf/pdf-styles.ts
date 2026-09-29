import { StyleSheet } from "@react-pdf/renderer";

/**
 * The results document's colours and type, resolved to literal values —
 * `@react-pdf/renderer` has no CSS variables, the same reason
 * `email-layout.ts` resolves the design system's tokens to hex. They are the
 * design system's, so the PDF matches the wizard's Review screen.
 */
export const COLORS = {
	primary: "#1588C1",
	text: "#1B242D",
	muted: "#546474",
	border: "#E1E6EA",
	accent: "#D9F0FC",
	accentText: "#0E5A81",
	success: "#29A36A",
	successBg: "#E1F4EA",
	danger: "#DD2C3B",
	dangerBg: "#FBE4E6",
	page: "#FFFFFF",
} as const;

/** The fixed footer strip, reserved out of every page's bottom margin. */
const FOOTER_HEIGHT = 14;

const BORDER = { borderColor: COLORS.border, borderWidth: 0.75 } as const;

export const pdfStyles = StyleSheet.create({
	page: {
		padding: 18,
		// The bottom margin also holds the fixed footer.
		paddingBottom: 18 + FOOTER_HEIGHT + 4,
		fontSize: 8.5,
		fontFamily: "Helvetica",
		color: COLORS.text,
	},
	frame: { borderTopWidth: 3, borderTopColor: COLORS.primary, paddingTop: 8 },
	header: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "flex-start",
		marginBottom: 8,
	},
	wpName: { fontSize: 11, fontFamily: "Helvetica-Bold" },
	muted: { fontSize: 7.5, color: COLORS.muted },
	formTitle: {
		fontSize: 10.5,
		fontFamily: "Helvetica-Bold",
		color: COLORS.primary,
		textAlign: "right",
	},
	pill: {
		alignSelf: "flex-end",
		marginTop: 3,
		paddingVertical: 2,
		paddingHorizontal: 8,
		borderRadius: 8,
		backgroundColor: COLORS.accent,
		color: COLORS.accentText,
		fontSize: 7.5,
		fontFamily: "Helvetica-Bold",
	},
	section: { ...BORDER, borderRadius: 4, padding: 6, marginBottom: 4 },
	sectionTitle: {
		fontSize: 8,
		fontFamily: "Helvetica-Bold",
		color: COLORS.primary,
		textTransform: "uppercase",
		marginBottom: 4,
	},
	subTitle: {
		fontSize: 7.5,
		fontFamily: "Helvetica-Bold",
		color: COLORS.primary,
		textTransform: "uppercase",
		marginTop: 4,
		marginBottom: 2,
	},
	table: {
		borderTopWidth: 0.75,
		borderLeftWidth: 0.75,
		borderColor: COLORS.border,
		marginBottom: 3,
	},
	row: { flexDirection: "row" },
	cell: {
		flexGrow: 1,
		flexBasis: 0,
		paddingVertical: 2.5,
		paddingHorizontal: 5,
		borderRightWidth: 0.75,
		borderBottomWidth: 0.75,
		borderColor: COLORS.border,
	},
	cellHighlight: { backgroundColor: COLORS.accent },
	label: { fontSize: 6.5, color: COLORS.muted, textTransform: "uppercase" },
	value: { fontSize: 9, fontFamily: "Helvetica-Bold", marginTop: 1 },
	answerRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingVertical: 3,
		paddingHorizontal: 5,
		borderRightWidth: 0.75,
		borderBottomWidth: 0.75,
		borderColor: COLORS.border,
	},
	answerLabel: { fontSize: 8.5, fontFamily: "Helvetica-Bold" },
	checks: { flexDirection: "row", alignItems: "center" },
	check: { flexDirection: "row", alignItems: "center", marginLeft: 10 },
	box: {
		width: 8,
		height: 8,
		borderWidth: 0.9,
		borderColor: COLORS.muted,
		borderRadius: 1.5,
		marginRight: 3,
	},
	boxOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
	tiles: { flexDirection: "row" },
	tile: {
		flexGrow: 1,
		flexBasis: 0,
		height: 24,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 4,
		...BORDER,
	},
	tilePass: { backgroundColor: COLORS.successBg, borderColor: COLORS.success },
	tileFail: { backgroundColor: COLORS.dangerBg, borderColor: COLORS.danger },
	tileText: { fontSize: 10, fontFamily: "Helvetica-Bold" },
	comment: {
		minHeight: 22,
		padding: 4,
		borderRadius: 3,
		backgroundColor: "#F5F8FA",
	},
	photos: { flexDirection: "row", marginTop: 6 },
	photo: {
		height: 130,
		maxWidth: 240,
		objectFit: "contain",
		marginRight: 8,
		...BORDER,
		borderRadius: 3,
	},
	disclaimer: { fontSize: 8, lineHeight: 1.3 },
	footer: {
		position: "absolute",
		left: 18,
		right: 18,
		bottom: 18,
		height: FOOTER_HEIGHT,
		paddingTop: 3,
		borderRadius: 3,
		backgroundColor: COLORS.accent,
		color: COLORS.accentText,
		textAlign: "center",
		fontSize: 7.5,
		fontFamily: "Helvetica-Bold",
	},
});

export function yesNo(value: unknown): string {
	if (value === true) return "Yes";
	if (value === false) return "No";
	return "—";
}

export function textValue(value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	return String(value);
}

/** A stored answer as the words a reader expects: "pass" → "Pass". */
export function titleCase(value: unknown): string {
	const text = textValue(value);

	return text === "—" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
