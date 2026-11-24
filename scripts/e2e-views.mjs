#!/usr/bin/env node

/**
 * Browser-level end-to-end check for the five views.
 *
 * ## Why this exists
 *
 * Every earlier "all green" claim in this project was made at the HTTP level: a 200 and a
 * non-empty body. That is not the same as a working page. A React render error, a failed
 * `/api/*` fetch, or an unhandled promise rejection all leave the status at 200 while the
 * operator sees a blank or half-rendered view. The ledger's token column is a live example:
 * it is rendered client-side, so it does not exist in the server HTML at all and an HTTP
 * check cannot see whether it ever appeared.
 *
 * So this script asserts what a person would actually notice:
 *   - the page renders a heading (the shell mounted),
 *   - no console error and no page exception occurred,
 *   - no request to the app's own origin failed, and no `/api/*` answered non-2xx,
 *   - view-specific content actually reached the DOM.
 *
 * ## Usage
 *
 *   npm run start --workspace app -- -p 3100     # in another shell
 *   node scripts/e2e-views.mjs --base http://127.0.0.1:3100
 *
 * Exits non-zero on the first view that fails, printing what failed. A browser that cannot be
 * launched is a failure, not a skip: silently passing when nothing ran is the exact failure
 * mode this script was written to remove.
 */

import fs from "node:fs";
import { chromium } from "playwright-core";
import { VIEWS } from "../app/src/config/views.ts";

const CHROME_CANDIDATES = [
  process.env.SAPU_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function parseArgs(argv) {
  const out = { base: "http://127.0.0.1:3100", timeout: 120_000, headful: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") out.base = argv[++i];
    else if (arg === "--timeout") out.timeout = Number(argv[++i]);
    else if (arg === "--headful") out.headful = true;
  }
  return out;
}

/**
 * Assertions per view, beyond "the page did not throw".
 *
 * Each entry names content that only appears once the view's real data has rendered — not a
 * skeleton. They are matched case-insensitively because several headers use `label-caps`,
 * which uppercases via CSS, so `innerText` reports "IN BURNER NOW" while the source says
 * "in burner now". Matching the source casing here would have been a false failure.
 */
const EXPECTED = {
  registry: ["route registry", "burner"],
  arm: ["arm", "burner"],
  // The token column is the multi-token proof: it exists only in the data table, so this
  // asserts the ledger actually rendered its rows rather than a pending state.
  ledger: ["sweep ledger", "in burner now", "token"],
  budget: ["budget", "sweep"],
  refusals: ["refusal", "revert"],
};

/** Noise that is not a page fault: favicon 404s and known dev-only chatter. */
function isIgnorable(text) {
  return /favicon|Download the React DevTools|\[Fast Refresh\]/i.test(text);
}

async function checkView(browser, base, view, timeout) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const apiFailures = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!isIgnorable(text)) consoleErrors.push(text);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (isIgnorable(url)) return;
    failedRequests.push(`${request.method()} ${url} — ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(base) || !url.includes("/api/")) return;
    if (response.status() >= 400) apiFailures.push(`${response.status()} ${url}`);
  });

  const problems = [];
  try {
    const response = await page.goto(`${base}${view.href}`, {
      waitUntil: "domcontentloaded",
      timeout,
    });

    if (response === null) {
      problems.push("no response object for the navigation");
    } else if (response.status() !== 200) {
      problems.push(`HTTP ${response.status()}`);
    }

    // Wait for the client shell to mount. `networkidle` is not used because the views poll on
    // an interval, so the network is never idle by design.
    await page.waitForSelector("h1", { timeout });

    // Let the first data fetch settle. The slowest endpoint (`/api/watch`, `/api/routes` on a
    // cold cache) takes ~12 s live; the poll interval then refreshes, so this is a wait for
    // the *first* paint of data rather than for stability.
    await page.waitForLoadState("networkidle").catch(() => {});

    const bodyText = await page.evaluate(() => document.body.innerText);
    const html = await page.content();
    const haystack = bodyText.toLowerCase();

    for (const needle of EXPECTED[view.id] ?? []) {
      if (!haystack.includes(needle.toLowerCase())) {
        problems.push(`expected text not rendered: "${needle}"`);
      }
    }

    // A React error boundary or Next.js error overlay means the view did not really work,
    // even when the HTTP status was 200.
    if (/Application error|Unhandled Runtime Error|__next_error__/.test(html)) {
      problems.push("error overlay / error boundary present in the DOM");
    }

    // A view that rendered nothing is a failure even if every assertion above passed.
    if (bodyText.trim().length < 40) {
      problems.push(`page body is nearly empty (${bodyText.trim().length} chars)`);
    }
  } catch (error) {
    problems.push(`navigation/assertion threw: ${error.message.split("\n")[0]}`);
  }

  if (consoleErrors.length > 0) problems.push(`console errors: ${consoleErrors.join(" | ")}`);
  if (pageErrors.length > 0) problems.push(`page exceptions: ${pageErrors.join(" | ")}`);
  if (failedRequests.length > 0) problems.push(`failed requests: ${failedRequests.join(" | ")}`);
  if (apiFailures.length > 0) problems.push(`API non-2xx: ${apiFailures.join(" | ")}`);

  await context.close();
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Prove the server is up before blaming a view for failing to load.
  try {
    const health = await fetch(`${args.base}/api/health`, { signal: AbortSignal.timeout(15_000) });
    if (!health.ok) throw new Error(`/api/health returned ${health.status}`);
  } catch (error) {
    console.error(`E2E FAILED: ${args.base} is not serving (${error.message.split("\n")[0]})`);
    console.error("Start it with: npm run start --workspace app -- -p 3100");
    process.exit(1);
  }

  const executablePath = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  let browser;
  try {
    browser = executablePath
      ? await chromium.launch({ executablePath, headless: !args.headful })
      : await chromium.launch({ channel: "chrome", headless: !args.headful });
  } catch (error) {
    console.error(`E2E FAILED: could not launch a browser (${error.message.split("\n")[0]})`);
    console.error("Set SAPU_CHROME_PATH to a Chrome/Edge binary.");
    process.exit(1);
  }

  let failures = 0;
  for (const view of VIEWS) {
    const problems = await checkView(browser, args.base, view, args.timeout);
    if (problems.length === 0) {
      console.log(`PASS  ${view.href.padEnd(14)} ${view.label}`);
      continue;
    }
    failures += 1;
    console.log(`FAIL  ${view.href.padEnd(14)} ${view.label}`);
    for (const problem of problems) console.log(`        - ${problem}`);
  }

  await browser.close();

  if (failures > 0) {
    console.log(`\n${failures} of ${VIEWS.length} views failed in a real browser.`);
    process.exit(1);
  }
  console.log(`\nAll ${VIEWS.length} views rendered with no console errors and no failed requests.`);
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
