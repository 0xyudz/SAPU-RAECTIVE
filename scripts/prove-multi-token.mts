#!/usr/bin/env node

/**
 * Live proof that SAPU arms a route for an arbitrary ERC-20, not just the demo token.
 *
 * The contracts are token-agnostic — `SapuForwarder` keys rules by `(token, burner)` and
 * `SapuRSC` subscribes once per pair with the token as the log filter — so the app layer must
 * never resolve `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` in place of the token being armed. This drives
 * the application's real `armRoute` for a token that is *not* the configured default and checks,
 * on-chain, that the resulting route names that token.
 *
 * Two third-party tokens are used, chosen because they differ from the demo token in both
 * symbol and scale, and because one of them is a proxy:
 *
 * - Circle's test USDC (6 decimals, ZeppelinOS proxy). Its runtime bytecode is a forwarder
 *   with no ERC-20 selectors, so a naive selector search reports "no EIP-2612" for a token that
 *   fully implements it — the bug `permit-support.ts` now avoids by following the proxy.
 * - WETH predeploy (18 decimals, no permit), which must take the burner-signed `approve` path.
 *
 * ## Why the token must be funded
 *
 * `armRoute` inspects the live allowance and rule for the token being armed; it does not
 * require a balance. But a route armed against a token the deployer cannot acquire proves less
 * than one that can actually move value, so this reports the deployer's balance and refuses to
 * call the run a success when the route does not appear on-chain for the right token.
 *
 * ## Usage
 *
 *   npx tsx --tsconfig app/tsconfig.json scripts/prove-multi-token.mts
 *
 * Requires: DEPLOYER_PRIVATE_KEY (forwarder owner), REACTIVE_PRIVATE_KEY (RSC owner), and an
 * armed burner key. Reads the deployment from `app/.env.local` then `.env`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ContractWriter } from "@/application/ports";

// First, so `config/chain-rpc.ts` (imported transitively below) snapshots a populated `env`.
import { repoRoot } from "./lib/env.mts";
import { rpcTransport, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";
import { createHeadlessWriter } from "./lib/app-writer.mts";

const APP = path.join(repoRoot, "app");
const appModule = (relative: string) => pathToFileURL(path.join(APP, relative)).href;

const { armRoute } = await import(appModule("src/application/registration-service.ts"));
const { readPermitSupport } = await import(appModule("src/infrastructure/permit-support.ts"));
const { probeTokenMetadata } = await import(appModule("src/infrastructure/token-probe.ts"));

/** Tokens this proof tries, in order. All are real third-party contracts on Base Sepolia. */
const CANDIDATES = [
  {
    label: "Circle test USDC",
    address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    note: "6 decimals, ZeppelinOS proxy — permit lives in the implementation",
  },
  {
    label: "WETH predeploy",
    address: "0x4200000000000000000000000000000000000006",
    note: "18 decimals, no EIP-2612 — takes the burner-signed approve path",
  },
] as const;

const RSC_ABI = parseAbi([
  "function routeOf(address token, address burner) view returns ((address coldWallet, bool active, uint64 registeredBlock))",
  "function sapuForwarder() view returns (address)",
]);
const FWD_ABI = parseAbi([
  "function ruleOf(address token, address burner) view returns ((address coldWallet, bool armed))",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

function requireAddress(name: string, value: string | undefined): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte address; got ${value ?? "(unset)"}`);
  }
  return value as `0x${string}`;
}

async function main(): Promise<void> {
  const originRpc = process.env.NEXT_PUBLIC_RPC_URL_84532 ?? process.env.BASE_SEPOLIA_RPC_URL;
  const reactiveRpc = process.env.REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";
  if (!originRpc) throw new Error("Set BASE_SEPOLIA_RPC_URL (or NEXT_PUBLIC_RPC_URL_84532).");

  const rsc = requireAddress(
    "SAPU_RSC_ADDRESS",
    process.env.SAPU_RSC_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS,
  );
  const forwarder = requireAddress(
    "SAPU_FORWARDER_ADDRESS",
    process.env.SAPU_FORWARDER_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS,
  );
  const configuredToken = requireAddress(
    "SAPU_TOKEN_ADDRESS",
    process.env.SAPU_TOKEN_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS,
  );

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const reactiveKey = process.env.REACTIVE_PRIVATE_KEY;
  if (!deployerKey || !reactiveKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY (forwarder owner) and REACTIVE_PRIVATE_KEY (RSC owner) are required.");
  }
  const deployer = privateKeyToAccount(deployerKey as `0x${string}`);

  const burnerKey = process.env.SAPU_BURNER_PRIVATE_KEY;
  if (!burnerKey) throw new Error("SAPU_BURNER_PRIVATE_KEY is required: arming needs a burner key.");
  const burner = privateKeyToAccount(burnerKey as `0x${string}`).address;

  const coldWallet = requireAddress(
    "SAPU_COLD_WALLET",
    process.env.SAPU_COLD_WALLET ?? deployer.address,
  );

  const originClient = createPublicClient({
    transport: rpcTransport(originRpc, BASE_SEPOLIA_FALLBACKS),
  });
  const reactiveClient = createPublicClient({
    transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS),
  });

  const [originChainId, activeForwarder] = await Promise.all([
    originClient.getChainId(),
    reactiveClient.readContract({
      address: rsc,
      abi: RSC_ABI,
      functionName: "sapuForwarder",
    }) as Promise<`0x${string}`>,
  ]);

  console.log("=== deployment ===");
  console.log(`rsc               ${rsc} (chain ${process.env.NEXT_PUBLIC_SAPU_REACTIVE_CHAIN_ID ?? "?"})`);
  console.log(`forwarder         ${forwarder} (chain ${originChainId})`);
  console.log(`rsc->forwarder    ${activeForwarder}`);
  console.log(`configured token  ${configuredToken}  <- the default this proof must NOT use`);
  console.log(`burner            ${burner}`);
  console.log(`cold wallet       ${coldWallet}`);

  const writer: ContractWriter = createHeadlessWriter({
    // `armRoute` needs the burner key to grant the forwarder an allowance: a permit for tokens
    // that have EIP-2612, or a burner-signed `approve` for those that do not. Without it the
    // flow correctly refuses, which would make this proof fail for the wrong reason.
    burnerPrivateKey: burnerKey as `0x${string}`,
    routeFor: (call) => {
      // The RSC lives on the Reactive chain and the forwarder on the origin chain. The token is
      // written by the forwarder, so it is an origin-chain call.
      const reactive = call.contract === "rsc";
      return {
        address: reactive ? privateKeyToAccount(reactiveKey as `0x${string}`).address : deployer.address,
        privateKey: reactive ? (reactiveKey as `0x${string}`) : (deployerKey as `0x${string}`),
        rpcUrl: reactive ? reactiveRpc : originRpc,
        fallbacks: reactive ? REACTIVE_FALLBACKS : BASE_SEPOLIA_FALLBACKS,
        publicClient: createPublicClient({
          transport: rpcTransport(reactive ? reactiveRpc : originRpc, reactive ? REACTIVE_FALLBACKS : BASE_SEPOLIA_FALLBACKS),
        }),
      };
    },
  });

  const results: Array<{ label: string; token: `0x${string}`; ok: boolean; detail: string }> = [];

  for (const candidate of CANDIDATES) {
    const token = candidate.address as `0x${string}`;
    console.log(`\n=== ${candidate.label} ${token} ===`);
    console.log(`  ${candidate.note}`);

    // 1. Metadata must be read from THIS token, not from the configured default.
    const probe = await probeTokenMetadata(token);
    if (probe.kind !== "read") {
      const detail = `metadata probe did not read: ${probe.kind}${
        "reason" in probe ? ` (${probe.reason})` : ""
      }`;
      console.log(`  FAIL ${detail}`);
      results.push({ label: candidate.label, token, ok: false, detail });
      continue;
    }
    const symbol = probe.symbol;
    const decimals = probe.decimals;
    console.log(`  symbol/decimals   ${symbol} / ${decimals} (read from this address)`);

    // 2. Permit support must be answered for THIS token, following proxies.
    const permit = await readPermitSupport(token);
    console.log(`  permit support    ${permit === null ? "unknown" : permit}`);

    // 3. Arm through the app's real service.
    const outcome = await armRoute(
      writer,
      {
        rsc,
        forwarder,
        burner,
        coldWallet,
        token,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        chainId: originChainId,
      },
      {
        onEvent: (event) => {
          if (event.type === "simulating" || event.type === "signing") {
            console.log(`  ${event.type.padEnd(10)} ${event.label}`);
          }
          if (event.type === "pending") console.log(`  pending    ${event.hash}`);
          if (event.type === "confirmed") {
            console.log(
              `  confirmed  ${event.receipt.hash} block=${event.receipt.blockNumber} gas=${event.receipt.gasUsed}`,
            );
          }
          if (event.type === "failed") console.log(`  failed     ${event.reason}`);
        },
      },
    );

    if (!outcome.ok) {
      console.log(`  FAIL armRoute: ${outcome.reason}`);
      results.push({ label: candidate.label, token, ok: false, detail: outcome.reason });
      continue;
    }
    console.log(`  receipts          ${outcome.receipts.length}`);

    // 4. Re-read the chain and require the route to name THIS token.
    const [rule, allowance, deployerBalance] = await Promise.all([
      originClient.readContract({
        address: forwarder,
        abi: FWD_ABI,
        functionName: "ruleOf",
        args: [token, burner],
      }),
      originClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [burner, forwarder],
      }),
      originClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [deployer.address],
      }),
    ]);

    const armed = rule.armed;
    const coldMatches = rule.coldWallet.toLowerCase() === coldWallet.toLowerCase();
    const allowanceOk = allowance > 0n;

    console.log(`  rule.armed        ${armed}`);
    console.log(`  rule.coldWallet   ${rule.coldWallet} (${coldMatches ? "matches" : "MISMATCH"})`);
    console.log(`  allowance         ${allowance === 0n ? "0" : "> 0"}`);
    console.log(`  deployer balance  ${formatUnits(deployerBalance, decimals)} ${symbol}`);

    // A second, independent confirmation that the route is registered for this token on the
    // Reactive side, not for the configured one.
    const route = await reactiveClient.readContract({
      address: rsc,
      abi: RSC_ABI,
      functionName: "routeOf",
      args: [token, burner],
    });
    console.log(`  rsc route.active  ${route.active}`);
    console.log(`  rsc route.cold    ${route.coldWallet}`);

    const ok =
      armed &&
      coldMatches &&
      allowanceOk &&
      route.active &&
      route.coldWallet.toLowerCase() === coldWallet.toLowerCase();
    const detail = ok
      ? `armed ${symbol}/${decimals} at ${token}`
      : `armed=${armed} coldMatches=${coldMatches} allowance=${allowanceOk} rscActive=${route.active}`;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${detail}`);
    results.push({ label: candidate.label, token, ok, detail });
  }

  console.log("\n=== summary ===");
  for (const result of results) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.label.padEnd(18)} ${result.token}  ${result.detail}`);
  }

  const allOk = results.length > 0 && results.every((result) => result.ok);
  const usedConfigured = results.some(
    (result) => result.token.toLowerCase() === configuredToken.toLowerCase(),
  );
  if (usedConfigured) {
    console.error("\nthe configured demo token was used; this run does not prove multi-token arming");
    process.exitCode = 1;
    return;
  }
  if (!allOk) process.exitCode = 1;
  console.log(
    `\n${allOk ? "PASS" : "FAIL"}: ${results.filter((r) => r.ok).length}/${results.length} routes armed for tokens other than the configured default`,
  );
}

await main().catch((error) => {
  console.error("multi-token proof failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
