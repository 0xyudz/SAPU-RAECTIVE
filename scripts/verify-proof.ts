#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createPublicClient, formatUnits, parseAbi, parseAbiItem, parseEventLogs } from "viem";

import { rpcTransport, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";
import { decodeCallbackRequest } from "./lib/reactive-decoding";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
loadEnv({ path: path.join(REPO_ROOT, "app", ".env.local"), quiet: true });

const TOKENS_SWEPT = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);

/**
 * How far the callback and the sweep it caused may sit apart in time.
 *
 * Two runs of the same demo deposit the same amount to the same burner with the same cold
 * wallet, so their `executeSweep` payloads are byte-identical. The payload is still the
 * authoritative link, but when several callbacks link equally it cannot pick one. The
 * callback request and the sweep are seconds apart; separate runs are minutes apart. This
 * window is the tie-break, not the primary link.
 */
const CALLBACK_WINDOW_SECONDS = 120;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CALLBACK_REQUEST = parseAbiItem(
  "event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, uint8 version, bytes configuration)",
);
const ROUTE_REGISTERED = parseAbiItem(
  "event RouteRegistered(address indexed burner, address indexed coldWallet, address indexed token, uint64 gasLimit)",
);

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

interface Leg {
  readonly hash: `0x${string}`;
  readonly blockNumber: string;
  readonly chainId: number;
}

interface Proof {
  readonly transactions: Record<"arm" | "deposit" | "callback" | "sweep", Leg>;
  readonly contracts: { rsc: `0x${string}`; forwarder: `0x${string}`; token: `0x${string}` };
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

async function main(): Promise<void> {
  const baseRpc = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  const reactiveRpc = process.env.REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";

  const base = createPublicClient({ transport: rpcTransport(baseRpc, BASE_SEPOLIA_FALLBACKS) });
  const reactive = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });

  // Which client verifies which leg is decided by the chain ids the nodes report, not by
  // a literal. The previous version compared against `84532` and sent everything else to
  // the Reactive client, so a proof recorded on any other origin would have been checked
  // against the wrong chain — and reported a bogus "no receipt" failure.
  const [originChainId, reactiveChainId] = await Promise.all([base.getChainId(), reactive.getChainId()]);
  const clientsByChain = new Map<number, typeof base>([
    [originChainId, base],
    [reactiveChainId, reactive],
  ]);

  const proof = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, "docs", "proof", "latest.json"), "utf8"),
  ) as Proof;

  const token = proof.contracts.token;
  const forwarder = proof.contracts.forwarder;
  const rsc = proof.contracts.rsc;
  const [symbol, decimals] = await Promise.all([
    base.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
    base.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
  ]);

  const results: string[] = [];
  let ok = true;
  const fail = (message: string) => {
    ok = false;
    results.push(`FAIL  ${message}`);
  };
  const pass = (message: string) => results.push(`PASS  ${message}`);

  // ---------------------------------------------------------------------------------------
  // Every recorded hash must exist, have succeeded, and be on the chain it claims.
  // ---------------------------------------------------------------------------------------
  for (const [label, tx] of Object.entries(proof.transactions) as [string, Leg][]) {
    const client = clientsByChain.get(tx.chainId);
    if (client === undefined) {
      fail(
        `${label.padEnd(8)} proof names chain ${tx.chainId}, but the configured RPCs are ` +
          `${originChainId} (origin) and ${reactiveChainId} (reactive)`,
      );
      continue;
    }
    const receipt = await client.getTransactionReceipt({ hash: tx.hash });
    if (receipt.status !== "success") {
      fail(`${label.padEnd(8)} ${tx.hash} reverted at block ${receipt.blockNumber}`);
      continue;
    }
    pass(`${label.padEnd(8)} ${tx.hash} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
  }

  // ---------------------------------------------------------------------------------------
  // The sweep is the anchor: it names the burner, token, cold wallet and amount that moved.
  // ---------------------------------------------------------------------------------------
  const sweepBlock = BigInt(proof.transactions.sweep.blockNumber);
  const sweepLogs = await base.getLogs({
    address: forwarder,
    event: TOKENS_SWEPT,
    fromBlock: sweepBlock,
    toBlock: sweepBlock,
  });
  const sweep = sweepLogs.find((entry) => same(entry.args.token, token)) ?? null;
  if (!sweep) {
    fail("no TokensSwept for the proof's token in the recorded sweep block");
    console.log(results.join("\n"));
    process.exit(1);
  }

  const burner = sweep.args.burner!;
  const coldWallet = sweep.args.coldWallet!;
  const sweptAmount = sweep.args.amount ?? 0n;

  pass(
    `sweep    burner=${burner} amount=${formatUnits(sweptAmount, Number(decimals))} ${symbol} ` +
      `coldWallet=${coldWallet} reactiveSender=${sweep.args.reactiveSender}`,
  );

  if (!same(sweep.args.reactiveSender, rsc)) {
    fail(`sweep reactiveSender ${sweep.args.reactiveSender} is not the proof's SapuRSC ${rsc}`);
  } else {
    pass("sweep reactiveSender is the proof's SapuRSC (callback-driven, not a rescue)");
  }

  // ---------------------------------------------------------------------------------------
  // deposit → sweep must be causal: same token, same burner, same amount, earlier block.
  // ---------------------------------------------------------------------------------------
  const depositReceipt = await base.getTransactionReceipt({ hash: proof.transactions.deposit.hash });
  const transfers = parseEventLogs({ abi: [TRANSFER], eventName: "Transfer", logs: depositReceipt.logs });
  const deposit = transfers.find(
    (entry) => same(entry.address, token) && same(entry.args.to, burner),
  );

  if (!deposit) {
    fail(`deposit tx ${proof.transactions.deposit.hash} carries no Transfer of ${symbol} to ${burner}`);
  } else if (deposit.args.value !== sweptAmount) {
    fail(
      `deposit amount ${formatUnits(deposit.args.value, Number(decimals))} ${symbol} != ` +
        `swept amount ${formatUnits(sweptAmount, Number(decimals))} ${symbol}`,
    );
  } else if (depositReceipt.blockNumber >= sweepBlock) {
    fail(
      `deposit block ${depositReceipt.blockNumber} is not before the sweep block ${sweepBlock}; ` +
        "the legs come from different runs",
    );
  } else {
    pass(
      `deposit  ${formatUnits(deposit.args.value, Number(decimals))} ${symbol} to ${burner} ` +
        `at block ${depositReceipt.blockNumber} < sweep ${sweepBlock}`,
    );
  }

  // ---------------------------------------------------------------------------------------
  // arm must be a real RouteRegistered for this burner/token/cold wallet.
  // ---------------------------------------------------------------------------------------
  const armReceipt = await reactive.getTransactionReceipt({ hash: proof.transactions.arm.hash });
  const registered = parseEventLogs({
    abi: [ROUTE_REGISTERED],
    eventName: "RouteRegistered",
    logs: armReceipt.logs,
  }).find(
    (entry) =>
      same(entry.address, rsc) &&
      same(entry.args.burner, burner) &&
      same(entry.args.token, token) &&
      same(entry.args.coldWallet, coldWallet),
  );
  if (!registered) {
    fail(`arm tx ${proof.transactions.arm.hash} has no RouteRegistered for ${burner} + cold wallet ${coldWallet}`);
  } else {
    pass(`arm      RouteRegistered burner=${burner} token=${token} coldWallet=${coldWallet}`);
  }

  // ---------------------------------------------------------------------------------------
  // callback → sweep must be causal: the decoded `executeSweep` payload names exactly what
  // the sweep moved. This is the authoritative link; block timestamps are only the fallback.
  // ---------------------------------------------------------------------------------------
  const callbackReceipt = await reactive.getTransactionReceipt({ hash: proof.transactions.callback.hash });
  const requests = parseEventLogs({
    abi: [CALLBACK_REQUEST],
    eventName: "CallbackRequest",
    logs: callbackReceipt.logs,
  }).filter((entry) => same(entry.args.recipient, forwarder));

  const linked = requests
    .map((entry) => ({ entry, decoded: decodeCallbackRequest(entry.args.configuration!) }))
    .find(
      ({ decoded }) =>
        decoded !== null &&
        same(decoded.token, token) &&
        same(decoded.burner, burner) &&
        same(decoded.coldWallet, coldWallet) &&
        decoded.amount === sweptAmount,
    );

  if (!linked) {
    fail(
      `callback tx ${proof.transactions.callback.hash} carries no executeSweep payload for ` +
        `${burner} / ${formatUnits(sweptAmount, Number(decimals))} ${symbol}`,
    );
  } else {
    pass(
      `callback executeSweep(token=${token}, burner=${burner}, amount=${sweptAmount}) ` +
        "matches the sweep",
    );

    // The payload cannot separate two identical runs, so check that the callback is close
    // enough in time to be the one that caused this sweep.
    const [sweepClock, callbackClock] = await Promise.all([
      base.getBlock({ blockNumber: sweepBlock }),
      reactive.getBlock({ blockNumber: callbackReceipt.blockNumber }),
    ]);
    const delta = Math.abs(Number(callbackClock.timestamp) - Number(sweepClock.timestamp));
    if (delta > CALLBACK_WINDOW_SECONDS) {
      fail(
        `callback and sweep are ${delta}s apart (> ${CALLBACK_WINDOW_SECONDS}s); they come ` +
          "from different runs, even though their executeSweep payloads are identical",
      );
    } else {
      pass(`callback and sweep are ${delta}s apart`);
    }
  }

  // The cold wallet's current balance is information, not a proof: it may have been spent
  // after the sweep. Reporting it as PASS/FAIL would turn later activity into a false failure.
  const coldBalance = await base.readContract({
    address: token,
    abi: ERC20,
    functionName: "balanceOf",
    args: [coldWallet],
  });
  results.push(`INFO  cold wallet ${coldWallet} holds ${formatUnits(coldBalance, Number(decimals))} ${symbol}`);

  console.log(results.join("\n"));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("proof verification failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
