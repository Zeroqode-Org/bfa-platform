import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Resend's `from` accepts a bare address or `Display Name <address>`; anything
 * else is refused by the API, so it is refused here first.
 */
const senderAddress = z.string().refine(
	(value) => {
		const address = value.match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? value;
		return z.email().safeParse(address.trim()).success;
	},
	{ message: "must be an email address or `Display Name <address>`" },
);

export const env = createEnv({
	server: {
		DATABASE_URL: z.string().min(1),
		SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
		// Which driver `sendEmail` uses. `console` needs nothing, which is why CI
		// and every local checkout can leave every email variable unset.
		EMAIL_DRIVER: z.enum(["console", "provider"]).default("console"),
		RESEND_API_KEY: z
			.string()
			.startsWith("re_", { message: "must be a Resend API key (re_…)" })
			.optional(),
		RESEND_FROM_EMAIL: senderAddress.optional(),
		// Where a recipient's reply goes. Provider configuration, not message data:
		// every transactional email shares one monitored mailbox.
		RESEND_REPLY_TO: z
			.email({ message: "must be an email address" })
			.optional(),
	},
	// The Resend variables are optional one at a time and required together
	// once the provider is switched on — a rule across fields, so it lives on
	// the whole object. A misconfigured deployment fails here, at startup,
	// rather than on the first invitation somebody sends.
	createFinalSchema: (shape) =>
		z.object(shape).superRefine((value, ctx) => {
			if (value.EMAIL_DRIVER !== "provider") {
				return;
			}

			for (const key of [
				"RESEND_API_KEY",
				"RESEND_FROM_EMAIL",
				"RESEND_REPLY_TO",
			] as const) {
				if (!value[key]) {
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: `${key} is required when EMAIL_DRIVER=provider`,
					});
				}
			}
		}),
	runtimeEnv: process.env,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
	emptyStringAsUndefined: true,
});
