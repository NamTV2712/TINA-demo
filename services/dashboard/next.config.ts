import type { NextConfig } from "next";
import path from "path";
import fs from "fs";

const normalizeBasePath = (value?: string) => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

// Read version from tina monorepo root VERSION file
function getVersion(): string {
  const candidates = [
    path.resolve(__dirname, "../../VERSION"),       // services/dashboard -> tina root
    path.resolve(__dirname, "VERSION"),              // local fallback
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf-8").trim();
    } catch {}
  }
  return "dev";
}

const TINA_API_URL = process.env.TINA_API_URL;
if (!TINA_API_URL) {
  throw new Error("TINA_API_URL is required: dashboard rewrites must use the release/deploy SSOT, not a baked fallback");
}

const nextConfig: NextConfig = {
  // Only use standalone output for production builds
  ...(process.env.NODE_ENV === 'production' ? { output: 'standalone' } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // Ensure Turbopack uses this project as root
  // (avoids picking a parent lockfile and serving nothing)
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Expose app version from tina VERSION file at build time
  env: {
    NEXT_PUBLIC_APP_VERSION: getVersion(),
  },
  // TINA has no public dashboard domain configured yet.
  allowedDevOrigins: [],
  // Proxy /b/ routes to the agentic gateway for VNC/CDP (supports WebSocket upgrade)
  async rewrites() {
    return [
      {
        source: "/b/:path*",
        destination: `${TINA_API_URL}/b/:path*`,
      },
      {
        source: "/ws",
        destination: `${TINA_API_URL}/ws`,
      },
    ];
  },
  // Route the optional docs host to its home page until a separate docs URL is configured.
  async redirects() {
    const docsBase = (process.env.NEXT_PUBLIC_DOCS_URL || "").trim().replace(/\/+$/, "");
    return [
      {
        source: "/docs",
        destination: docsBase || "/",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: docsBase ? `${docsBase}/:path*` : "/",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
