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
 *   - view-specific content actually reached the DOM,
 *   - `/api/watch` answers about the whole deployment, not just the last few thousand blocks.
 *
 * The last one is not a view check, and that is the point: no view calls `/api/watch`, so its
 * default window could be wrong for every real burner without a single page noticing.
 *
 * ## Usage
 *
 *   npm run start --workspace app -- -p 3100     # in another shell
 *   node scripts/e2e-views.mjs --base http://127.0.0.1:3100
 *
 * Exits non-zero when any check fails, printing what failed. A browser that cannot be launched
 * is a failure, not a skip: silently passing when nothing ran is the exact failure mode this
 * script was written to remove.
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

    // Poll for the expected content instead of sampling once after `networkidle`.
    //
    // The single sample was flaky: `/app/ledger` renders its table client-side after a fetch
    // that takes 0.3–11 s depending on the log cache, and a snapshot taken at the wrong moment
    // reported "expected text not rendered" for a view that was simply still loading. Waiting
    // for the content is what the assertion means; guessing a delay is not.
    const needles = EXPECTED[view.id] ?? [];
    const deadline = Date.now() + timeout;
    let bodyText = "";
    for (;;) {
      bodyText = await page.evaluate(() => document.body.innerText);
      const haystack = bodyText.toLowerCase();
      if (needles.every((needle) => haystack.includes(needle.toLowerCase()))) break;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(250);
    }

    const html = await page.content();
    const haystack = bodyText.toLowerCase();

    for (const needle of needles) {
      if (!haystack.includes(needle.toLowerCase())) {
        problems.push(`expected text not rendered after ${timeout} ms: "${needle}"`);
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

/**
 * Proves `/api/watch` answers about the *deployment*, not just about the last few thousand
 * blocks.
 *
 * ## Why this check exists
 *
 * The endpoint's default window used to be `head - 5_000`. On the live deployment the oldest
 * swept burner is ~1.7M blocks behind the head, so a burner the ledger already reported as
 * `complete` was answered with `receipts: []` — the same body a never-funded burner gets. No
 * unit test could catch that: the bug lived in the default, not in the correlation logic.
 *
 * The burner is taken from the live ledger rather than hardcoded, so this asserts the shipped
 * path on whatever deployment it runs against. A deployment with no completed sweep is reported
 * as SKIP and named as such — it is not counted as a pass.
 */
async function checkWatchCoverage(base, timeout) {
  const problems = [];
  const ledgerResponse = await fetch(`${base}/api/ledger`, { signal: AbortSignal.timeout(timeout) });
  if (!ledgerResponse.ok) {
    return { status: "FAIL", problems: [`/api/ledger returned ${ledgerResponse.status}`] };
  }

  const ledger = await ledgerResponse.json();
  const complete = (ledger.rows ?? []).find(
    (row) => row.status === "complete" && row.coldWallet && row.deposit,
  );
  if (complete === undefined) {
    return {
      status: "SKIP",
      problems: [],
      note: "no completed sweep in the ledger, so there is no known-good receipt to demand",
    };
  }

  const url = `${base}/api/watch?burner=${complete.burner}&token=${complete.token}&cold=${complete.coldWallet}`;

  // One retry, because the underlying failure can be the node rather than this code.
  //
  // Observed live: a burst of six concurrent calls produced one
  // `502 {"error":"HTTP request failed … eth_blockNumber … fetch failed"}`. The endpoint was
  // right to report it — a failed read must never become an empty result — but a gate that
  // fails on a transient RPC blip trains people to ignore it. The retry is bounded at two
  // attempts, and the body is printed on the final failure so a genuine regression is still
  // visible instead of being retried away.
  let response;
  let detail = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (response.ok) break;
    detail = await response.text().catch(() => "");
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  if (!response.ok) {
    // Include the body: a bare "returned 502" hides whether the node rate-limited, timed out,
    // or rejected a chunk, and those need different fixes.
    return {
      status: "FAIL",
      problems: [`/api/watch returned ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`],
    };
  }

  const body = await response.json();

  // The whole point: a sweep the ledger calls complete must be visible to the default window.
  if (!Array.isArray(body.receipts) || body.receipts.length === 0) {
    problems.push(
      `default /api/watch returned no receipt for a burner the ledger reports as complete (${complete.burner})`,
    );
  }

  if (typeof body.summary !== "string" || body.summary.length === 0) {
    problems.push("response has no summary sentence, so an empty receipts array is ambiguous");
  }

  const window = body.window;
  if (window === undefined || window === null) {
    problems.push("response has no window object");
  } else {
    if (window.originFromSource !== "deploy-block") {
      problems.push(`default window source is "${window.originFromSource}", expected "deploy-block"`);
    }
    if (window.coversFullHistory !== true) {
      problems.push("default window does not cover the deployment history, so an empty answer would be a guess");
    }
    if (typeof window.originFromBlock !== "string" || typeof window.originHeadBlock !== "string") {
      problems.push("window is missing originFromBlock/originHeadBlock");
    }
  }

  return { status: problems.length === 0 ? "PASS" : "FAIL", problems };
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

  // API-level assertions that a browser cannot make: the views never call `/api/watch`, so a
  // blank page would not reveal a wrong default window.
  const watch = await checkWatchCoverage(args.base, args.timeout).catch((error) => ({
    status: "FAIL",
    problems: [`/api/watch check threw: ${error.message.split("\n")[0]}`],
  }));

  if (watch.status === "PASS") {
    console.log("PASS  /api/watch    default window covers the deployment");
  } else if (watch.status === "SKIP") {
    console.log(`SKIP  /api/watch    ${watch.note}`);
  } else {
    failures += 1;
    console.log("FAIL  /api/watch    default window covers the deployment");
    for (const problem of watch.problems) console.log(`        - ${problem}`);
  }

  if (failures > 0) {
    // `process.exit(1)` here crashed Node on Windows with a libuv assertion
    // (`!(handle->flags & UV_HANDLE_CLOSING)`), because undici's keep-alive sockets are still
    // being torn down while the exit runs. Setting `exitCode` lets the loop drain and still
    // reports failure, so a failing gate fails *cleanly* instead of looking like a crash.
    console.log(`\n${failures} check(s) failed in a real browser.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nAll ${VIEWS.length} views rendered with no console errors and no failed requests, and /api/watch covered its deployment.`,
  );
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
