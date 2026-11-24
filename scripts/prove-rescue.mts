#!/usr/bin/env node

/**
 * Live proof for use case #4: `rescueSweep`.
 *
 * This drives the application's real `rescueResidue` service — the same module the ledger's
 * Rescue button calls — against the live deployment. Nothing here re-implements the write
 * pipeline: `simulateCall` and `submitPrepared` are the shared infrastructure, so a passing
 * run proves the production code path rather than a parallel one. The only substitution is
 * the wallet: a headless run signs with `DEPLOYER_PRIVATE_KEY` (the forwarder owner) instead
 * of an injected browser wallet.
 *
 * ## What makes the residue genuine
 *
 * This script does not create the condition it proves. It reads whatever is sitting in the
 * burner and refuses to run when that is zero, so a "pass" cannot be a staged no-op. A real
 * residue appears whenever a deposit is stranded: a callback dropped at a too-low gas limit,
 * a deposit below `minDeposit`, or a route disarmed mid-flight. `prove-dust-floor.mts`
 * produces one deliberately (the floor refuses the deposit and `DustIgnored` records it),
 * and the recorded live runs recovered exactly that.
 *
 * ## Usage
 *
 *   npx tsx --tsconfig app/tsconfig.json scripts/prove-rescue.mts [--burner 0x…]
 *
 * Requires: DEPLOYER_PRIVATE_KEY (forwarder owner) and an armed route whose burner holds
 * tokens.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ContractWriter, WriteProgressEvent } from "@/application/ports";

// First, so `config/chain-rpc.ts` (imported transitively below) snapshots a populated `env`.
import { repoRoot } from "./lib/env.mts";
import { rpcTransport, BASE_SEPOLIA_FALLBACKS } from "./lib/rpc";
import { createHeadlessWriter } from "./lib/app-writer.mts";

const APP = path.join(repoRoot, "app");

// Windows absolute paths must be `file://` URLs for the ESM loader.
const appModule = (relative: string) => pathToFileURL(path.join(APP, relative)).href;

const { rescueResidue } = await import(appModule("src/application/rescue-service.ts"));
const { classifyResidue } = await import(appModule("src/domain/residue.ts"));
const { readForwarderCapabilities } = await import(
  appModule("src/infrastructure/forwarder-capabilities.ts")
);

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const FWD = parseAbi([
  "function ruleOf(address,address) view returns ((address coldWallet, bool armed))",
  "function owner() view returns (address)",
  "function sweepCount() view returns (uint256)",
]);

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requireAddress(name: string, value: string | undefined): `0x${string}` {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte address; got ${value ?? "(unset)"}`);
  }
  return value as `0x${string}`;
}

/**
 * The burner to inspect.
 *
 * `SAPU_BURNER_ADDRESS` is optional in `.env`: the operator persists `SAPU_BURNER_PRIVATE_KEY`
 * and the address is derivable from it. Requiring both meant this script refused to run on the
 * very deployment that uses a persisted key, which is the normal case after the arming fix.
 */
function resolveBurner(): `0x${string}` {
  const explicit = argValue("--burner") ?? process.env.SAPU_BURNER_ADDRESS;
  if (explicit !== undefined) return requireAddress("--burner (or SAPU_BURNER_ADDRESS)", explicit);

  const key = process.env.SAPU_BURNER_PRIVATE_KEY;
  if (key) {
    const derived = privateKeyToAccount(key as `0x${string}`).address;
    console.log(`burner            ${derived} (derived from SAPU_BURNER_PRIVATE_KEY)`);
    return derived;
  }

  throw new Error(
    "No burner given. Pass --burner 0x…, or set SAPU_BURNER_ADDRESS / SAPU_BURNER_PRIVATE_KEY.",
  );
}

async function main(): Promise<void> {
  const originRpc = process.env.NEXT_PUBLIC_RPC_URL_84532 ?? process.env.BASE_SEPOLIA_RPC_URL;
  if (!originRpc) throw new Error("Set BASE_SEPOLIA_RPC_URL (or NEXT_PUBLIC_RPC_URL_84532).");

  const token = requireAddress(
    "SAPU_TOKEN_ADDRESS",
    process.env.SAPU_TOKEN_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS,
  );
  const forwarder = requireAddress(
    "SAPU_FORWARDER_ADDRESS",
    process.env.SAPU_FORWARDER_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS,
  );
  const burner = resolveBurner();

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required: rescueSweep is onlyOwner.");

  const owner = privateKeyToAccount(deployerKey as `0x${string}`);
  const publicClient = createPublicClient({ transport: rpcTransport(originRpc, BASE_SEPOLIA_FALLBACKS) });

  const [balance, allowance, symbol, decimals, rule, fwdOwner, sweepBefore, capabilities] =
    await Promise.all([
      publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [burner] }),
      publicClient.readContract({
        address: token,
        abi: ERC20,
        functionName: "allowance",
        args: [burner, forwarder],
      }),
      publicClient.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
      publicClient.readContract({ address: forwarder, abi: FWD, functionName: "ruleOf", args: [token, burner] }),
      publicClient.readContract({ address: forwarder, abi: FWD, functionName: "owner" }),
      publicClient.readContract({ address: forwarder, abi: FWD, functionName: "sweepCount" }),
      readForwarderCapabilities(forwarder),
    ]);
  const dp = Number(decimals);

  console.log("=== before ===");
  console.log(`signer            ${owner.address}`);
  console.log(`forwarder owner   ${fwdOwner}`);
  console.log(`is owner          ${fwdOwner.toLowerCase() === owner.address.toLowerCase()}`);
  console.log(`forwarder         ${forwarder}`);
  console.log(
    `rescueSweep       ${
      capabilities.rescueSweep === null
        ? "unknown (bytecode unreadable)"
        : capabilities.rescueSweep
          ? "present in bytecode"
          : "ABSENT from bytecode"
    }`,
  );
  console.log(`burner balance    ${formatUnits(balance, dp)} ${symbol}`);
  console.log(`allowance         ${allowance >= balance ? ">= balance" : formatUnits(allowance, dp)}`);
  console.log(`rule.armed        ${rule.armed}`);
  console.log(`rule.coldWallet   ${rule.coldWallet}`);
  console.log(`sweepCount        ${sweepBefore}`);

  // Refuse to prove a no-op. A rescue of an empty burner reverts with `NothingToSweep`, which
  // would prove nothing except that the contract rejects empty input.
  if (balance === 0n) {
    console.error(
      `\nnothing to rescue: ${burner} holds 0 ${symbol}.\n` +
        "This script proves the rescue of a real residue, so it will not create one. Strand a\n" +
        "deposit first (scripts/prove-dust-floor.mts does it through the real dust floor), then\n" +
        "re-run.",
    );
    process.exitCode = 1;
    return;
  }
  if (capabilities.rescueSweep === false) {
    console.error(`\nthe deployed forwarder has no rescueSweep selector; this deployment cannot be rescued.`);
    process.exitCode = 1;
    return;
  }
  if (!rule.armed) {
    console.error(`\nroute is not armed for ${burner} + ${token}; rescueSweep would revert RouteNotArmed.`);
    process.exitCode = 1;
    return;
  }
  if (fwdOwner.toLowerCase() !== owner.address.toLowerCase()) {
    console.error(
      `\nDEPLOYER_PRIVATE_KEY is ${owner.address}, but the forwarder owner is ${fwdOwner}. ` +
        "rescueSweep is onlyOwner.",
    );
    process.exitCode = 1;
    return;
  }

  const coldBefore = await publicClient.readContract({
    address: token,
    abi: ERC20,
    functionName: "balanceOf",
    args: [rule.coldWallet],
  });
  console.log(`cold wallet holds ${formatUnits(coldBefore, dp)} ${symbol}`);

  /**
   * The writer the app gets from `createConnectedWriter`, minus the injected wallet.
   *
   * The transport is shared with every other live script (`scripts/lib/app-writer.ts`), so the
   * simulate → preflight → send → receipt pipeline here is the production one. `submitPrepared`
   * takes the *inner* viem request, not the `{call, request}` wrapper — `connected-writer`
   * unwraps it first, and the real ledger writer does the same.
   */
  const writer: ContractWriter = createHeadlessWriter({
    routeFor: () => ({
      address: owner.address,
      privateKey: deployerKey as `0x${string}`,
      rpcUrl: originRpc,
      // Retries are nonce-pinned, so failing over mid-send cannot duplicate the transaction.
      fallbacks: BASE_SEPOLIA_FALLBACKS,
      publicClient,
    }),
  });

  const residue = classifyResidue({
    liveBalance: balance,
    depositAmount: balance.toString(),
    sweptAmount: null,
  });
  console.log(`\nresidue.state     ${residue.state}`);

  console.log("\n=== rescueResidue (app service) ===");
  const outcome = await rescueResidue(
    writer,
    {
      forwarder,
      token,
      burner,
      coldWallet: rule.coldWallet,
      residue,
      tokenSymbol: symbol,
      tokenDecimals: dp,
    },
    {
      onEvent: (event: WriteProgressEvent) => {
        if (event.type === "simulating" || event.type === "signing") {
          console.log(`  ${event.type.padEnd(10)} ${event.label}`);
        }
        if (event.type === "pending") console.log(`  pending    ${event.hash}`);
        if (event.type === "confirmed") {
          console.log(`  confirmed  ${event.receipt.hash}`);
          console.log(
            `             block=${event.receipt.blockNumber} gasUsed=${event.receipt.gasUsed} ` +
              `status=${event.receipt.status}`,
          );
        }
        if (event.type === "failed") console.log(`  failed     ${event.reason}`);
      },
    },
  );

  if (!outcome.ok) {
    console.error(`\nRESCUE FAILED: ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }

  const [balanceAfter, coldAfter, sweepAfter] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [burner] }),
    publicClient.readContract({
      address: token,
      abi: ERC20,
      functionName: "balanceOf",
      args: [rule.coldWallet],
    }),
    publicClient.readContract({ address: forwarder, abi: FWD, functionName: "sweepCount" }),
  ]);

  console.log("\n=== after ===");
  console.log(`rescue tx         ${outcome.receipt.hash}`);
  console.log(`burner balance    ${balanceAfter} base units`);
  console.log(
    `cold wallet       ${formatUnits(coldAfter, dp)} ${symbol} (was ${formatUnits(coldBefore, dp)})`,
  );
  console.log(`cold delta        ${formatUnits(coldAfter - coldBefore, dp)} ${symbol}`);
  console.log(`sweepCount        ${sweepAfter} (was ${sweepBefore})`);

  const emptied = balanceAfter === 0n;
  const received = coldAfter - coldBefore === balance;
  const counted = sweepAfter === sweepBefore + 1n;
  const ok = emptied && received && counted;

  console.log(
    `\n${ok ? "PASS" : "FAIL"}: burner emptied, cold wallet gained exactly ` +
      `${formatUnits(balance, dp)} ${symbol}, and the rescue counted as a sweep`,
  );
  if (!ok) {
    if (!emptied) console.error(`  burner still holds ${formatUnits(balanceAfter, dp)} ${symbol}`);
    if (!received) {
      console.error(
        `  cold wallet delta ${formatUnits(coldAfter - coldBefore, dp)} != ${formatUnits(balance, dp)}`,
      );
    }
    if (!counted) console.error(`  sweepCount ${sweepAfter} != ${sweepBefore + 1n}`);
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error("rescue proof failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
