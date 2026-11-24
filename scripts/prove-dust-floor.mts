#!/usr/bin/env node

/**
 * Live proof for use case #5: the dust floor.
 *
 * Drives the application's real `applyBudgetAction` (the `/app/budget` write path) to raise
 * `SapuRSC.minDeposit`, deposits below the new floor, and asserts the RSC emitted
 * `DustIgnored` instead of requesting a sweep. Then it restores the floor.
 *
 * ## What this proves, and what it deliberately does not
 *
 * The claim is not "a small deposit is ignored". It is that the ignoring is *observable*: the
 * tokens really stay in the burner, no `PurgeTriggered` is emitted, and `DustIgnored` is the
 * chain fact that lets the ledger explain why instead of inferring it from the amount. The
 * script reads the floor straight from the node after every write (`readMinDeposit`), because
 * `readBudget` is cached for 8 seconds and echoing it back would print a stale value as the
 * live floor.
 *
 * It leaves the deposit stranded on purpose — that is the residue `prove-rescue.mts` recovers.
 * Run them in that order for a full #5 → #4 demonstration.
 *
 * ## Usage
 *
 *   npx tsx --tsconfig app/tsconfig.json scripts/prove-dust-floor.mts [--burner 0x…] [--amount 0.5]
 *
 * Requires: REACTIVE_PRIVATE_KEY (RSC owner) and DEPLOYER_PRIVATE_KEY (funds the deposit).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, formatUnits, parseAbi, parseAbiItem, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ContractWriter } from "@/application/ports";
import type { BudgetSnapshot } from "@/application/budget-controls";

// First, so `config/chain-rpc.ts` (imported transitively below) snapshots a populated `env`.
import { repoRoot } from "./lib/env.mts";
import {
  rpcTransport,
  signerTransport,
  sendWithReconcile,
  BASE_SEPOLIA_FALLBACKS,
  REACTIVE_FALLBACKS,
} from "./lib/rpc";
import { createHeadlessWriter } from "./lib/app-writer.mts";

const APP = path.join(repoRoot, "app");

const appModule = (relative: string) => pathToFileURL(path.join(APP, relative)).href;

const { applyBudgetAction } = await import(appModule("src/application/budget-controls.ts"));
const { readBudget } = await import(appModule("src/infrastructure/budget-reader.ts"));
const { readDebt, readMinDeposit, readNativeBalance } = await import(
  appModule("src/infrastructure/chain-reads.ts")
);
const { readRscCapabilities } = await import(appModule("src/infrastructure/rsc-capabilities.ts"));
const { withRpcRetry } = await import(appModule("src/infrastructure/rpc-retry.ts"));

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);
const FWD = parseAbi(["function sweepCount() view returns (uint256)"]);
const DUST_IGNORED = parseAbiItem(
  "event DustIgnored(address indexed burner, address indexed token, uint256 amount)",
);
const PURGE_TRIGGERED = parseAbiItem(
  "event PurgeTriggered(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, uint256 originBlockNumber)",
);

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

/** `SAPU_BURNER_ADDRESS` is optional; the address is derivable from the persisted key. */
function resolveBurner(): `0x${string}` {
  const explicit = argValue("--burner") ?? process.env.SAPU_BURNER_ADDRESS;
  if (explicit !== undefined) return requireAddress("--burner (or SAPU_BURNER_ADDRESS)", explicit);

  const key = process.env.SAPU_BURNER_PRIVATE_KEY;
  if (key) return privateKeyToAccount(key as `0x${string}`).address;

  throw new Error(
    "No burner given. Pass --burner 0x…, or set SAPU_BURNER_ADDRESS / SAPU_BURNER_PRIVATE_KEY.",
  );
}

async function main(): Promise<void> {
  const originRpc = process.env.NEXT_PUBLIC_RPC_URL_84532 ?? process.env.BASE_SEPOLIA_RPC_URL;
  const reactiveRpc = process.env.NEXT_PUBLIC_REACTIVE_RPC_URL ?? process.env.REACTIVE_RPC_URL;
  if (!originRpc) throw new Error("Set BASE_SEPOLIA_RPC_URL (or NEXT_PUBLIC_RPC_URL_84532).");
  if (!reactiveRpc) throw new Error("Set REACTIVE_RPC_URL.");

  const token = requireAddress(
    "SAPU_TOKEN_ADDRESS",
    process.env.SAPU_TOKEN_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS,
  );
  const rsc = requireAddress(
    "SAPU_RSC_ADDRESS",
    process.env.SAPU_RSC_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS,
  );
  const forwarder = requireAddress(
    "SAPU_FORWARDER_ADDRESS",
    process.env.SAPU_FORWARDER_ADDRESS ?? process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS,
  );
  const burner = resolveBurner();

  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const reactiveKey = process.env.REACTIVE_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required to fund the deposit.");
  if (!reactiveKey) throw new Error("REACTIVE_PRIVATE_KEY is required: setMinDeposit is onlyOwner.");

  const deployer = privateKeyToAccount(deployerKey as `0x${string}`);
  const reactiveAccount = privateKeyToAccount(reactiveKey as `0x${string}`);

  const originPublic = createPublicClient({ transport: rpcTransport(originRpc, BASE_SEPOLIA_FALLBACKS) });
  const originSigner = createPublicClient({
    transport: signerTransport(originRpc, BASE_SEPOLIA_FALLBACKS),
  });
  const originWallet = createWalletClient({
    account: deployer,
    transport: signerTransport(originRpc, BASE_SEPOLIA_FALLBACKS),
  });
  const reactive = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });

  /**
   * Routes each call to the chain and key that hosts that contract.
   *
   * `setMinDeposit` is `onlyOwner` on the RSC, which lives on the Reactive chain, so those calls
   * sign with the Reactive key; everything else signs with the deployer. The writer itself is the
   * shared headless one, so the simulate → preflight → send → receipt pipeline is the app's.
   */
  const writer: ContractWriter = createHeadlessWriter({
    routeFor: (call) =>
      call.contract === "rsc"
        ? {
            address: reactiveAccount.address,
            privateKey: reactiveKey as `0x${string}`,
            rpcUrl: reactiveRpc,
            fallbacks: REACTIVE_FALLBACKS,
            publicClient: reactive,
          }
        : {
            address: deployer.address,
            privateKey: deployerKey as `0x${string}`,
            rpcUrl: originRpc,
            fallbacks: BASE_SEPOLIA_FALLBACKS,
            publicClient: originPublic,
          },
  });

  const logEvent = (event: {
    type: string;
    label?: string;
    hash?: string;
    reason?: string;
    receipt?: { hash: string; blockNumber: bigint; gasUsed: bigint; status: string };
  }) => {
    if (event.type === "simulating" || event.type === "signing") {
      console.log(`  ${event.type.padEnd(10)} ${event.label}`);
    }
    if (event.type === "pending") console.log(`  pending    ${event.hash}`);
    if (event.type === "confirmed" && event.receipt) {
      console.log(`  confirmed  ${event.receipt.hash}`);
      console.log(
        `             block=${event.receipt.blockNumber} gasUsed=${event.receipt.gasUsed} ` +
          `status=${event.receipt.status}`,
      );
    }
    if (event.type === "failed") console.log(`  failed     ${event.reason}`);
  };

  /**
   * Live snapshot for the preflight diff.
   *
   * `readBudget` is cached for 8s, so every value this script makes a decision on is read live
   * instead. Taking the cached copies would show a stale floor or a stale debt as the current
   * one: the run that exposed this reported debt still owed *after* `coverDebt` had already
   * succeeded, because the check reused the pre-write snapshot.
   *
   * Each read is wrapped in the app's own `withRpcRetry`. Without it a single transient
   * `fetch failed` from the reactive node aborted the run *after* the dust assertion had passed
   * and before the floor was restored, leaving the deployment mutated. A read that is merely
   * flaky must not be able to strand live state.
   */
  async function snapshot(): Promise<BudgetSnapshot> {
    const budget = await readBudget(rsc, forwarder);
    const [minDeposit, rscBalance, rscDebt] = await Promise.all([
      withRpcRetry(() => readMinDeposit(rsc)),
      withRpcRetry(() => readNativeBalance("rsc")),
      withRpcRetry(() => readDebt("system", rsc)),
    ]);
    return {
      callbackGasLimit: budget.callbackGasLimit,
      minDeposit,
      rscBalance,
      rscDebt,
      forwarderBalance: budget.forwarderBalance,
      gasPrice: budget.gasPrice,
      forwarderDebt: budget.forwarderDebt,
    };
  }

  /**
   * Settle RSC debt before the run, or stop with an explanation.
   *
   * An RSC in debt receives **no reactive transactions at all** — it does not revert, it simply
   * stops reacting. A dust proof run against a debt-burning RSC therefore waits out its whole
   * scan window and reports "no DustIgnored", which looks like a broken dust floor when the real
   * cause is an unfunded contract. The live stack hit exactly this: 0.0135661 REACT owed against
   * 0.0091963 held.
   *
   * `coverDebt()` is permissionless, and it is the app's own budget action, so settling it here
   * is the same code path `/app/budget` uses.
   */
  async function settleRscDebtIfNeeded(): Promise<boolean> {
    const before = await snapshot();
    if (before.rscDebt === 0n) return true;

    console.log(`\n  SapuRSC owes ${before.rscDebt} wei REACT and holds ${before.rscBalance}.`);
    console.log("  An RSC in debt receives no reactive transactions at all, so the dust floor");
    console.log("  cannot be observed until this is settled. Settling it through coverDebt().");
    const outcome = await applyBudgetAction(writer, { kind: "cover-debt", contract: "rsc" }, before, {
      onEvent: logEvent,
    });
    if (!outcome.ok) {
      console.error(`\n  cover-debt failed: ${outcome.reason}`);
      console.error(
        "  The RSC needs more REACT than it holds. Fund it, then re-run: a debt-burning RSC\n" +
          "  silently ignores every event, so any proof run against it is meaningless.",
      );
      return false;
    }

    // Confirm from a fresh read that the debt really cleared, rather than trusting the receipt.
    const after = await snapshot();
    if (after.rscDebt !== 0n) {
      console.error(`\n  debt is still ${after.rscDebt} wei REACT after cover-debt; refusing to continue.`);
      return false;
    }
    console.log("  debt cleared.");
    return true;
  }

  async function setFloor(value: bigint): Promise<void> {
    const before = await snapshot();
    console.log(
      `\n  snapshot: minDeposit=${before.minDeposit} gasLimit=${before.callbackGasLimit} ` +
        `rscDebt=${before.rscDebt}`,
    );
    const outcome = await applyBudgetAction(writer, { kind: "set-min-deposit", minDeposit: value }, before, {
      onEvent: logEvent,
    });
    if (!outcome.ok) throw new Error(`setMinDeposit failed: ${outcome.reason}`);
  }

  const [capabilities, symbol, decimals, senderBalance, burnerBefore, sweepBefore] = await Promise.all([
    readRscCapabilities(rsc),
    originPublic.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
    originPublic.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
    originPublic.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [deployer.address] }),
    originPublic.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [burner] }),
    originPublic.readContract({ address: forwarder, abi: FWD, functionName: "sweepCount" }),
  ]);
  const dp = Number(decimals);

  console.log("=== setup ===");
  console.log(`rsc               ${rsc}`);
  console.log(
    `dust floor        ${
      capabilities.dustFloor === null
        ? "unknown (bytecode unreadable)"
        : capabilities.dustFloor
          ? "present in bytecode"
          : "ABSENT from bytecode"
    }`,
  );
  console.log(`burner            ${burner}`);
  console.log(`burner before     ${formatUnits(burnerBefore, dp)} ${symbol}`);
  console.log(`sender balance    ${formatUnits(senderBalance, dp)} ${symbol}`);

  if (capabilities.dustFloor !== true) {
    console.error(
      "\nThe deployed SapuRSC does not implement minDeposit/setMinDeposit, so this proof cannot run.\n" +
        "That is the honest outcome for a deployment that predates the dust floor: the app reports\n" +
        "'not supported' rather than offering a control that would revert.",
    );
    process.exitCode = 1;
    return;
  }

  // Before anything else: an RSC in debt silently receives no events, so the whole proof would
  // be a no-op that looks like a failed dust floor.
  if (!(await settleRscDebtIfNeeded())) {
    process.exitCode = 1;
    return;
  }

  const amount = argValue("--amount") ?? "0.5";
  const DEPOSIT = parseUnits(amount, dp);
  // A floor strictly above the deposit, so the deposit must be ignored.
  const FLOOR = DEPOSIT * 4n;

  if (senderBalance < DEPOSIT) {
    // Only the demo token has a permissionless `mint`. A real ERC-20 does not, so a deployment
    // without one must say what is missing rather than send a call that can only revert.
    //
    // Probed with a simulation rather than a `readContract`: `mint` returns nothing, so a read
    // has no output to decode and viem rejects the call at the type level. A simulation of the
    // real write is also the more honest check — it asks the same question the send would.
    const mintable = await originPublic
      .simulateContract({
        address: token,
        abi: ERC20,
        functionName: "mint",
        args: [deployer.address, 0n],
        account: deployer,
      })
      .then(() => true)
      .catch(() => false);
    if (!mintable) {
      console.error(
        `\nsender ${deployer.address} holds ${formatUnits(senderBalance, dp)} ${symbol}, needs ${amount}, ` +
          "and this token has no permissionless mint(). Fund the sender with the token first.",
      );
      process.exitCode = 1;
      return;
    }
    const mintHash = await sendWithReconcile(
      "fund the deposit",
      (nonce) =>
        originWallet.writeContract({
          address: token,
          abi: ERC20,
          functionName: "mint",
          args: [deployer.address, DEPOSIT * 10n],
          chain: null,
          nonce,
        }),
      { client: originSigner, address: deployer.address },
    );
    await originPublic.waitForTransactionReceipt({ hash: mintHash });
    console.log(`  minted          ${formatUnits(DEPOSIT * 10n, dp)} ${symbol} (tx ${mintHash})`);
  }

  const floorAtStart = await readMinDeposit(rsc);

  // From here the deployment is mutated, so the restore runs in `finally`. The run that exposed
  // this aborted on a transient `fetch failed` *after* the dust assertion had passed and left the
  // floor at 2e18 — a proof script must not be able to strand live state by dying mid-way.
  let ok = false;
  try {
    console.log("\n=== 1. raise the dust floor through the app's budget service ===");
    await setFloor(FLOOR);
    const raised = await readMinDeposit(rsc);
    console.log(`  live minDeposit now ${raised} (expected ${FLOOR})`);
    if (raised !== FLOOR) {
      console.error("  the floor did not change; refusing to continue and report a proof that is not one");
      process.exitCode = 1;
      return;
    }

    console.log(
      `\n=== 2. deposit ${amount} ${symbol}, below the ${formatUnits(FLOOR, dp)} ${symbol} floor ===`,
    );

    // Snapshot the reactive head *before* the deposit. The RSC can react within a couple of
    // seconds, so snapshotting after the receipt raced the reaction and the scan window started
    // past the DustIgnored event it was looking for.
    const headAtDeposit = await reactive.getBlockNumber();

    const depositHash = await sendWithReconcile(
      "dust deposit",
      (nonce) =>
        originWallet.writeContract({
          address: token,
          abi: ERC20,
          functionName: "transfer",
          args: [burner, DEPOSIT],
          chain: null,
          nonce,
        }),
      { client: originSigner, address: deployer.address },
    );
    const depositReceipt = await originPublic.waitForTransactionReceipt({ hash: depositHash });
    console.log(`  deposit tx      ${depositHash} block=${depositReceipt.blockNumber}`);

    console.log("\n=== 3. wait for SapuRSC to react, then look for DustIgnored ===");
    // Typed from the event ABIs, not from `getLogs`' widened return: an explicit
    // `ReturnType<typeof reactive.getLogs>` annotation erases `args`, so every read of
    // `entry.args.burner` would have to be cast.
    type DustLog = { blockNumber: bigint | null; transactionHash: `0x${string}` | null; args: { burner?: `0x${string}`; amount?: bigint } };
    type PurgeLog = { args: { burner?: `0x${string}` } };
    let dustLogs: DustLog[] = [];
    let purgeLogs: PurgeLog[] = [];

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const head = await reactive.getBlockNumber();
      [dustLogs, purgeLogs] = await Promise.all([
        reactive.getLogs({ address: rsc, event: DUST_IGNORED, fromBlock: headAtDeposit, toBlock: head }),
        reactive.getLogs({ address: rsc, event: PURGE_TRIGGERED, fromBlock: headAtDeposit, toBlock: head }),
      ]);
      const seen = dustLogs.filter((entry) => entry.args.burner?.toLowerCase() === burner.toLowerCase());
      if (seen.length > 0) {
        console.log(`  observed after ${attempt * 6}s at reactive head ${head}`);
        break;
      }
      console.log(`  attempt ${attempt}: no DustIgnored yet (head ${head})`);
    }

    const mine = dustLogs.filter((entry) => entry.args.burner?.toLowerCase() === burner.toLowerCase());
    const myPurges = purgeLogs.filter(
      (entry) => entry.args.burner?.toLowerCase() === burner.toLowerCase(),
    );
    const [burnerAfter, sweepAfter] = await Promise.all([
      originPublic.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [burner] }),
      originPublic.readContract({ address: forwarder, abi: FWD, functionName: "sweepCount" }),
    ]);

    console.log(`\n  new DustIgnored events for this burner: ${mine.length}`);
    for (const entry of mine) {
      console.log(`    blk=${entry.blockNumber} tx=${entry.transactionHash} amount=${entry.args.amount}`);
    }
    console.log(`  PurgeTriggered events for this burner: ${myPurges.length}`);
    console.log(`  burner after    ${formatUnits(burnerAfter, dp)} ${symbol}`);
    console.log(`  sweepCount      ${sweepAfter} (was ${sweepBefore})`);

    const ignored = mine[0];
    ok =
      mine.length === 1 &&
      myPurges.length === 0 &&
      ignored?.args.amount === DEPOSIT &&
      burnerAfter === burnerBefore + DEPOSIT &&
      sweepAfter === sweepBefore;

    console.log(`\n  (window searched: reactive blocks ${headAtDeposit}..latest)`);
    console.log(
      `${ok ? "PASS" : "FAIL"}: deposit below the floor was ignored and stayed in the burner, ` +
        "observable as DustIgnored with no PurgeTriggered",
    );
    if (!ok) {
      if (mine.length !== 1) console.error(`  expected exactly 1 new DustIgnored, saw ${mine.length}`);
      if (myPurges.length !== 0) console.error(`  expected no PurgeTriggered, saw ${myPurges.length}`);
      if (ignored && ignored.args.amount !== DEPOSIT) {
        console.error(`  DustIgnored amount ${ignored.args.amount} != ${DEPOSIT}`);
      }
      if (burnerAfter !== burnerBefore + DEPOSIT) {
        console.error(`  burner delta ${burnerAfter - burnerBefore} != ${DEPOSIT}`);
      }
      if (sweepAfter !== sweepBefore) console.error(`  sweepCount moved ${sweepBefore} -> ${sweepAfter}`);
    }
  } finally {
    // Runs even when the assertion above threw. A transient `fetch failed` once aborted this
    // proof *after* the dust assertion passed and left the live floor at 2e18; a script must not
    // be able to strand live state by dying mid-way. The whole restore is retried because both
    // the write and the follow-up read go through public gateways that answer 429 in bursts.
    console.log(`\n=== 4. restore the floor to ${floorAtStart} ===`);
    let restored: bigint | null = null;
    for (let attempt = 1; attempt <= 3 && restored !== floorAtStart; attempt += 1) {
      if (attempt > 1) console.log(`  restore attempt ${attempt}/3`);
      try {
        await setFloor(floorAtStart);
      } catch (error) {
        console.error(
          `  restore write failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      try {
        restored = await withRpcRetry(() => readMinDeposit(rsc));
        if (restored !== floorAtStart) {
          // The reactive node can lag a write by a block; re-read before declaring failure.
          await new Promise((resolve) => setTimeout(resolve, 6000));
          restored = await withRpcRetry(() => readMinDeposit(rsc));
        }
      } catch (error) {
        console.error(
          `  restore read failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      console.log(`  live minDeposit now ${restored} (expected ${floorAtStart})`);
    }
    if (restored !== floorAtStart) {
      console.error(
        "\nthe floor was not restored; the deployment is left in a different state than it was found in",
      );
      process.exitCode = 1;
    }
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error("dust-floor proof failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
