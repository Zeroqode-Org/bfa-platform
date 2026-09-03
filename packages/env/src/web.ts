import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	client: {
		NEXT_PUBLIC_SUPABASE_URL: z.url(),
		NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
	},
	// `@t3-oss/env-nextjs` needs every NEXT_PUBLIC_* key listed literally here —
	// Next only inlines `process.env.NEXT_PUBLIC_*` for statically-seen references.
	runtimeEnv: {
		NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
		NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
	},
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
