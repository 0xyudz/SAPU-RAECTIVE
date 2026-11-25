#!/usr/bin/env node
/**
 * Docs gate: fail when README or docs/ still makes a stale "we haven't proven this" claim.
 *
 * Ported from scripts/audit-docs.sh because `bash` is not reliably on PATH for every
 * contributor (on this project's Windows checkout it resolves to the WSL stub, which exits 1
 * with "no installed distributions"). A gate that fails for an unrelated reason gets removed
 * or ignored, so it is better to have one implementation that runs everywhere `npm run audit`
 * runs.
 *
 * The original grepped for bare vocabulary (`pending`, `not verified`, `requires funded`),
 * which flagged two statements that are true and must stay:
 *
 *   README.md   "Requires funded keys - see .env.example"    reproduction instructions, not an excuse
 *   JUDGING.md  "idle -> ... -> pending -> confirmed"        a literal state-machine enum name
 *
 * Flagging those pressures people to weaken honest docs to satisfy the gate. So the patterns
 * below match *claims of incompleteness* rather than vocabulary, and the two legitimate shapes
 * are allowed by content, with the reason recorded next to them.
 *
 * Verified to fail: appending "the sweep has not been run" to docs/LIMITATIONS.md exits 1 and
 * names the file and line.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/** Claims that something was not actually done or verified. */
const STALE_CLAIMS = [
  /pending\s+(verification|proof|results?|confirmation)/i,
  /(^|[^a-z])not\s+(yet\s+)?verified/i,
  /no\s+verified/i,
  /not\s+been\s+run/i,
  /never\s+been\s+run/i,
  /awaiting\s+(verification|confirmation)/i,
  /(has\s+)?not\s+(yet\s+)?been\s+tested/i,
];

/**
 * Legitimate occurrences, allowed by content so the exclusion cannot silently widen.
 *
 * - "requires funded keys" is reproduction guidance, not a claim that evidence is missing.
 * - the `idle -> simulating -> signing -> pending -> confirmed` arrow chain is a state enum.
 */
const ALLOWED = [
  /requires funded keys/i,
  /idle\b.*simulating\b.*signing\b.*pending/i,
];

function docsFiles() {
  const readme = path.join(REPO_ROOT, "README.md");
  const docsDir = path.join(REPO_ROOT, "docs");
  const files = [];
  if (fs.existsSync(readme)) files.push(readme);
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(docsDir, entry.name));
      }
    }
  }
  return files;
}

const stale = [];
const allowed = [];

for (const file of docsFiles()) {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!STALE_CLAIMS.some((pattern) => pattern.test(line))) return;

    const where = `${rel}:${index + 1}`;
    if (ALLOWED.some((pattern) => pattern.test(line))) {
      allowed.push(`${where}: ${line.trim()}`);
    } else {
      stale.push(`${where}: ${line.trim()}`);
    }
  });
}

for (const line of allowed) console.log(`  allowed: ${line}`);

if (stale.length > 0) {
  console.error("stale claim in docs:");
  for (const line of stale) console.error(`  ${line}`);
  process.exit(1);
}

console.log("no stale pending claims");
