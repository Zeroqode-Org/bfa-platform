import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { normalizeAppUrl, normalizeVercelProductionUrl } from "./app-url";

/**
 * A string that `normalize` accepts. The normalizer's own message becomes the
 * issue, so startup reports the same reason a link builder would throw with.
 */
function urlVariable(normalize: (value: string) => string) {
	return z.string().superRefine((value, ctx) => {
		try {
			normalize(value.trim());
		} catch (error) {
			ctx.addIssue({ code: "custom", message: (error as Error).message });
		}
	});
}

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
		// Base URL for links in outbound mail — see `./app-url` for the order.
		// Both optional: unset everywhere means `http://localhost:3001`, which is
		// what local development, tests and CI want. Set but invalid fails here.
		APP_URL: urlVariable(normalizeAppUrl).optional(),
		// Legacy spelling of APP_URL, kept temporarily so existing environments
		// keep their links. Validated the same way; new configuration uses APP_URL.
		NEXT_PUBLIC_APP_URL: urlVariable((value) =>
			normalizeAppUrl(value, "NEXT_PUBLIC_APP_URL"),
		).optional(),
		// Provided by Vercel as a bare hostname, and only when the project has
		// "Automatically expose System Environment Variables" switched on.
		VERCEL_PROJECT_PRODUCTION_URL: urlVariable(
			normalizeVercelProductionUrl,
		).optional(),
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
