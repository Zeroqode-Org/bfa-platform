import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The schema is evaluated at import, so each case stubs `process.env` and
 * imports a fresh copy. Every value here is a placeholder — nothing is read
 * from a credentials file and nothing is sent.
 */
async function loadEnv(overrides: Record<string, string | undefined>) {
	vi.stubEnv("DATABASE_URL", "postgres://placeholder");
	vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "placeholder");
	vi.stubEnv("SKIP_ENV_VALIDATION", undefined);
	vi.stubEnv("EMAIL_DRIVER", undefined);
	vi.stubEnv("RESEND_API_KEY", undefined);
	vi.stubEnv("RESEND_FROM_EMAIL", undefined);
	vi.stubEnv("RESEND_REPLY_TO", undefined);

	for (const [key, value] of Object.entries(overrides)) {
		vi.stubEnv(key, value);
	}

	vi.resetModules();
	return (await import("./server")).env;
}

const provider = {
	EMAIL_DRIVER: "provider",
	RESEND_API_KEY: "re_placeholder",
	RESEND_FROM_EMAIL: "notifications@example.com",
	RESEND_REPLY_TO: "info@example.com",
};

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("email configuration", () => {
	it("defaults EMAIL_DRIVER to console and needs no Resend variables", async () => {
		const env = await loadEnv({});

		expect(env.EMAIL_DRIVER).toBe("console");
		expect(env.RESEND_API_KEY).toBeUndefined();
		expect(env.RESEND_REPLY_TO).toBeUndefined();
	});

	it("treats an empty EMAIL_DRIVER as unset", async () => {
		const env = await loadEnv({ EMAIL_DRIVER: "" });

		expect(env.EMAIL_DRIVER).toBe("console");
	});

	it("refuses an unknown driver", async () => {
		await expect(loadEnv({ EMAIL_DRIVER: "resend" })).rejects.toThrow(
			"Invalid environment variables",
		);
	});

	it("accepts the provider with every Resend variable", async () => {
		const env = await loadEnv({
			...provider,
			RESEND_FROM_EMAIL: "Backflow Reporter <notifications@example.com>",
		});

		expect(env.EMAIL_DRIVER).toBe("provider");
		expect(env.RESEND_REPLY_TO).toBe("info@example.com");
	});

	it("accepts a bare sender address", async () => {
		const env = await loadEnv(provider);

		expect(env.RESEND_FROM_EMAIL).toBe("notifications@example.com");
	});

	it.each(["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_REPLY_TO"] as const)(
		"refuses the provider without %s",
		async (missing) => {
			await expect(
				loadEnv({ ...provider, [missing]: undefined }),
			).rejects.toThrow("Invalid environment variables");

			expect(console.error).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining([
					expect.objectContaining({
						message: `${missing} is required when EMAIL_DRIVER=provider`,
					}),
				]),
			);
		},
	);

	it.each([
		["an API key without the re_ prefix", { RESEND_API_KEY: "not-a-key" }],
		["a malformed sender", { RESEND_FROM_EMAIL: "Backflow Reporter" }],
		["a reply-to that is not an email address", { RESEND_REPLY_TO: "info" }],
		[
			"a reply-to with a display name",
			{ RESEND_REPLY_TO: "Backflow Reporter <info@example.com>" },
		],
	])("refuses %s", async (_label, invalid) => {
		await expect(loadEnv({ ...provider, ...invalid })).rejects.toThrow(
			"Invalid environment variables",
		);
	});
});
