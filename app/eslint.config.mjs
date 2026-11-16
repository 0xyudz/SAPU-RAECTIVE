// ESLint flat config.
//
// Next.js 16 removed `next lint`; the supported path is running ESLint directly
// against a flat config that extends `eslint-config-next`. Keeping the script as
// `next lint` would have left `npm run lint` permanently broken.
//
// `core-web-vitals` layers the stricter Next.js rules (no <img>, no sync scripts,
// no document.write) on top of the base config. They are worth failing on: this
// app renders a live watcher and a QR code, and shipping a sync script would
// block the very first paint.

import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "coverage/**"],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
