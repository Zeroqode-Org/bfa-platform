import { TRPCError } from "@trpc/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The CSV route as plumbing: it hands the query string to
 * `exportSubmittedTests`, serves what comes back as a file, and turns a refusal
 * into the matching HTTP status.
 *
 * The procedure itself — tenancy, roles, drafts, the customer on the test date,
 * the row limit — runs against Postgres in `routers/submitted-tests.test.ts`.
 * Here it is a spy, so this suite stays offline and asserts only what the
 * route adds.
 */

const createContext = vi.fn();
const exportSubmittedTests = vi.fn();

vi.mock("@bfa-platform/api/context", () => ({
	createContext: (...args: unknown[]) => createContext(...args),
}));

vi.mock("@bfa-platform/api/routers/index", () => ({
	appRouter: {
		createCaller: () => ({ submittedTests: { exportSubmittedTests } }),
	},
}));

const { GET } = await import("./route");

function request(query: string) {
	return new NextRequest(
		`https://bfa.example.com/api/wp/submitted-tests/export${query}`,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	createContext.mockResolvedValue({});
});

describe("GET /api/wp/submitted-tests/export", () => {
	it("serves the rows as a CSV attachment named for the period", async () => {
		exportSubmittedTests.mockResolvedValue([
			{
				customerName: "Old Owner",
				bin: "HRB-0142",
				submittedBinText: null,
				serviceAddress: "12 Makai Rd",
				bfaType: "RP",
				testDate: "2027-03-02",
				testResult: "fail",
				certifierName: "Kai Certifier",
			},
		]);

		const response = await GET(
			request("?from=2027-03-01&to=2027-03-31&result=fail"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/csv; charset=utf-8",
		);
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="submitted-tests_2027-03-01_2027-03-31.csv"',
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain(
			"HRB-0142,Old Owner,12 Makai Rd,RP,03/02/2027,Fail,Kai Certifier",
		);
	});

	it("passes every query parameter through, so the procedure can refuse a stray one", async () => {
		exportSubmittedTests.mockResolvedValue([]);

		await GET(request("?from=2027-03-01&form=2027-03-31"));

		expect(exportSubmittedTests).toHaveBeenCalledWith({
			from: "2027-03-01",
			form: "2027-03-31",
		});
	});

	it("keeps a refreshed session cookie on the response", async () => {
		createContext.mockImplementation(async ({ resHeaders }) => {
			resHeaders.append("set-cookie", "sb-session=refreshed; Path=/");
			return {};
		});
		exportSubmittedTests.mockResolvedValue([]);

		const response = await GET(request(""));

		expect(response.headers.get("set-cookie")).toContain(
			"sb-session=refreshed",
		);
	});

	it.each([
		["UNAUTHORIZED", 401],
		["FORBIDDEN", 403],
		["BAD_REQUEST", 400],
		["PAYLOAD_TOO_LARGE", 413],
	] as const)(
		"answers %s with %i and the procedure's message",
		async (code, status) => {
			exportSubmittedTests.mockRejectedValue(
				new TRPCError({ code, message: `refused: ${code}` }),
			);

			const response = await GET(request(""));

			expect(response.status).toBe(status);
			expect(response.headers.get("content-disposition")).toBeNull();
			expect(await response.text()).toBe(`refused: ${code}`);
		},
	);

	it("says nothing about why an unexpected failure happened", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exportSubmittedTests.mockRejectedValue(
			new Error("connection string leaked here"),
		);

		const response = await GET(request(""));

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("The export failed. Try again.");
	});
});
