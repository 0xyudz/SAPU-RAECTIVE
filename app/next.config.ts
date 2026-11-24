import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The burner vault lives in browser memory only. Nothing here may ever be
  // persisted server-side; see docs/LIMITATIONS.md.
  experimental: {},
  env: {},
  /**
   * The landing page reads `docs/proof/latest.json` at request time.
   *
   * That read is deliberate: the proof is written by `scripts/e2e-demo.sh` after a live run, so
   * it must be the newest file on disk rather than something frozen into the bundle at build
   * time. But `proof-file.ts` resolves the path at runtime, which no bundler can trace — it is
   * marked `turbopackIgnore` for exactly that reason. On a plain Node server that is fine,
   * because the repository sits next to the app. On Vercel the deployment contains only traced
   * files, so the JSON was absent and the landing page fell back to "waiting for live run" with
   * zero transaction hashes: the strongest evidence on the page silently disappeared.
   *
   * `outputFileTracingIncludes` is the supported way to tell the tracer about a runtime read it
   * cannot see. `/*` is the documented global key and matches every route; the file itself is
   * under 3 KB, so including it everywhere costs nothing and removes any dependence on how this
   * particular build names the root route.
   */
  outputFileTracingIncludes: {
    "/*": ["../docs/proof/latest.json"],
  },
};

export default nextConfig;
