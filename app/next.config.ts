import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The burner vault lives in browser memory only. Nothing here may ever be
  // persisted server-side; see docs/LIMITATIONS.md.
  experimental: {},
  env: {},
};

export default nextConfig;
