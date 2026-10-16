import "@bfa-platform/env/web";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	typedRoutes: true,
	reactCompiler: true,
	// Dev only: other hosts allowed to load the dev server's assets, e.g. the
	// computer's LAN IP so the app can be opened from a phone on the same
	// network. Comma-separated, from the environment so no address is committed.
	allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean),
};

export default nextConfig;
