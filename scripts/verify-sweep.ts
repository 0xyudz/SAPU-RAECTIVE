#!/usr/bin/env node

import {
  createPublicClient,
  parseAbiItem,
  formatUnits,
  parseAbi,
  parseEventLogs,
  type Log,
} from "viem";
import { config as loadEnv } from "dotenv";

import { rpcTransport, withRpcRetry, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";
import { explorerFor } from "./lib/explorers";
import { decodeCallbackRequest, type DecodedSweepRequest } from "./lib/reactive-decoding";

loadEnv({ quiet: true });

const SYSTEM_CONTRACT = "0x8888888888888888888888888888888888888888" as const;

/**
 * How far a callback's timestamp may sit from the sweep it caused.
 *
 * The decoded payload is the authoritative link: it names the exact token, burner, cold
 * wallet and amount. But two runs of the same demo deposit the same amount to the same
 * burner, so the payload alone cannot tell them apart. The callback request and the sweep it
 * triggers are seconds apart; separate runs are minutes apart. A two-minute window is wide
 * enough for a slow run and narrow enough that an older run can never be selected.
 */
const CALLBACK_WINDOW_SECONDS = 120;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TOKENS_SWEPT = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);
const CALLBACK_REQUEST = parseAbiItem(
  "event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, uint8 version, bytes configuration)",
);

const ERC20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

interface Options {
  fromBlock: bigint;
  /** The deposit transaction this run made. When present, it anchors every other leg. */
  tx1: `0x${string}` | null;
  timeoutSeconds: number;
  json: boolean;
}

interface LegResult {
  found: boolean;
  txHash: `0x${string}` | null;
  blockNumber: bigint | null;
  timestamp: number | null;
  detail: string;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const fromBlockRaw = get("--from-block") ?? process.env.SAPU_FROM_BLOCK;
  const tx1Raw = get("--tx1");
  if (tx1Raw !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(tx1Raw)) {
    console.error(`--tx1 must be a 32-byte transaction hash, got: ${tx1Raw}`);
    process.exit(1);
  }

  return {
    fromBlock: fromBlockRaw ? BigInt(fromBlockRaw) : 0n,
    tx1: (tx1Raw ?? null) as `0x${string}` | null,
    timeoutSeconds: Number(get("--timeout") ?? "120"),
    json: argv.includes("--json"),
  };
}

function requireEnv(name: string): `0x${string}` {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    console.error(`Missing or invalid ${name}. See .env.example.`);
    process.exit(1);
  }
  return value as `0x${string}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function same(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

async function main(): Promise<void> {
  const options = parseArgs();

  const baseRpc = process.env.BASE_SEPOLIA_RPC_URL;
  const reactiveRpc = process.env.REACTIVE_RPC_URL;
  if (!baseRpc) {
    console.error("BASE_SEPOLIA_RPC_URL is required.");
    process.exit(1);
  }
  if (!reactiveRpc) {
    console.error("REACTIVE_RPC_URL is required.");
    process.exit(1);
  }

  const token = requireEnv("SAPU_TOKEN_ADDRESS");
  const burner = requireEnv("SAPU_BURNER_ADDRESS");
  const forwarder = requireEnv("SAPU_FORWARDER_ADDRESS");

  const base = createPublicClient({ transport: rpcTransport(baseRpc, BASE_SEPOLIA_FALLBACKS) });
  const reactive = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });

  const [symbol, decimals] = await Promise.all([
    base.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "?"),
    base.readContract({ address: token, abi: ERC20, functionName: "decimals" }).catch(() => 18),
  ]);

  // Chain ids and explorer URLs come from the nodes and the shared table, not from
  // constants. A hardcoded basescan link would point at the wrong explorer on any other
  // origin chain, which reads as evidence of a sweep that never happened there.
  const [originChainId, reactiveChainId] = await Promise.all([base.getChainId(), reactive.getChainId()]);
  const originExplorer = explorerFor(originChainId, process.env.SAPU_ORIGIN_EXPLORER_URL) ?? "";
  const reactiveExplorer = explorerFor(reactiveChainId, process.env.SAPU_REACTIVE_EXPLORER_URL) ?? "";
  if (!options.json && (originExplorer === "" || reactiveExplorer === "")) {
    console.warn(
      "warning: no explorer URL known for one of these chains. Set SAPU_ORIGIN_EXPLORER_URL / " +
        "SAPU_REACTIVE_EXPLORER_URL. Hashes are still verified; only the links are omitted.",
    );
  }

  const scanFrom = options.fromBlock > 0n ? options.fromBlock : null;

  if (!options.json) {
    console.log("== SAPU :: loop verification ==");
    console.log(`token        ${symbol} ${token}`);
    console.log(`burner       ${burner}`);
    console.log(`forwarder    ${forwarder}`);
    if (options.tx1) console.log(`deposit tx   ${options.tx1}`);
    console.log(`from block   ${scanFrom ?? "(from the deposit)"}`);
    console.log("");
  }

  // ---------------------------------------------------------------------------------------
  // Tx1 — the deposit
  //
  // When the caller names the deposit, that hash *is* Tx1. Falling back to "the first
  // Transfer at/after some block" let a replayed or older transaction stand in for this
  // run's deposit, which then paired with a newer callback. A named hash cannot drift.
  // ---------------------------------------------------------------------------------------
  let tx1: LegResult;
  let depositAmount = 0n;

  if (options.tx1) {
    const receipt = await withRpcRetry("tx1 receipt", () => base.getTransactionReceipt({ hash: options.tx1! }));
    if (receipt.status !== "success") {
      tx1 = {
        found: false,
        txHash: options.tx1,
        blockNumber: receipt.blockNumber,
        timestamp: null,
        detail: "deposit transaction reverted",
      };
    } else {
      const transfers = parseEventLogs({ abi: [TRANSFER], eventName: "Transfer", logs: receipt.logs }).filter(
        (entry) => same(entry.address, token) && same(entry.args.to, burner),
      );
      const transfer = transfers[0];
      tx1 = transfer
        ? {
            found: true,
            txHash: options.tx1,
            blockNumber: receipt.blockNumber,
            timestamp: null,
            detail: `${formatUnits(transfer.args.value, Number(decimals))} ${symbol} deposited`,
          }
        : {
            found: false,
            txHash: options.tx1,
            blockNumber: receipt.blockNumber,
            timestamp: null,
            detail: `transaction carries no Transfer of ${symbol} to the burner`,
          };
      depositAmount = transfer?.args.value ?? 0n;
    }
  } else {
    const startBlock = scanFrom ?? (await base.getBlockNumber());
    const deposits = await withRpcRetry("deposit logs", () =>
      base.getLogs({
        address: token,
        event: TRANSFER,
        args: { to: burner },
        fromBlock: startBlock,
        toBlock: "latest",
      }),
    );
    const deposit = deposits[0];
    tx1 = deposit
      ? {
          found: true,
          txHash: deposit.transactionHash!,
          blockNumber: deposit.blockNumber!,
          timestamp: null,
          detail: `${deposits.length} deposit(s); first ${formatUnits(deposit.args.value ?? 0n, Number(decimals))} ${symbol}`,
        }
      : { found: false, txHash: null, blockNumber: null, timestamp: null, detail: "no Transfer into burner" };
    depositAmount = deposit?.args.value ?? 0n;
  }

  if (tx1.blockNumber !== null) {
    const block = await base.getBlock({ blockNumber: tx1.blockNumber });
    tx1.timestamp = Number(block.timestamp);
  }

  // ---------------------------------------------------------------------------------------
  // Tx3 — the sweep this deposit caused
  //
  // It must be strictly after the deposit, for the same token, and the amount must match
  // exactly when such a sweep exists. "First sweep at/after the start block" could select a
  // different run's sweep; "after this deposit, same token" cannot.
  // ---------------------------------------------------------------------------------------
  const sweepFloor = tx1.blockNumber ?? scanFrom ?? (await base.getBlockNumber());
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let sweeps: Log<bigint, number, false, typeof TOKENS_SWEPT, true>[] = [];
  let sweep: Log<bigint, number, false, typeof TOKENS_SWEPT, true> | null = null;

  if (tx1.found) {
    if (!options.json) process.stdout.write("waiting for Tx3 sweep");
    while (Date.now() < deadline) {
      const all = await withRpcRetry("sweep logs", () =>
        base.getLogs({
          address: forwarder,
          event: TOKENS_SWEPT,
          args: { burner },
          fromBlock: sweepFloor,
          toBlock: "latest",
        }),
      );
      sweeps = all.filter(
        (entry) =>
          same(entry.args.token, token) &&
          (tx1.blockNumber === null || entry.blockNumber! > tx1.blockNumber),
      );
      const exact = sweeps.filter((entry) => entry.args.amount === depositAmount);
      sweep = exact[0] ?? sweeps[0] ?? null;
      if (sweep) break;
      if (!options.json) process.stdout.write(".");
      await sleep(3_000);
    }
    if (!options.json) process.stdout.write("\n\n");
  }

  const tx3: LegResult = sweep
    ? {
        found: true,
        txHash: sweep.transactionHash!,
        blockNumber: sweep.blockNumber!,
        timestamp: null,
        detail: `${formatUnits(sweep.args.amount ?? 0n, Number(decimals))} ${symbol} swept`,
      }
    : {
        found: false,
        txHash: null,
        blockNumber: null,
        timestamp: null,
        detail: tx1.found ? "no TokensSwept for this deposit within timeout" : "skipped (no deposit)",
      };

  if (tx3.blockNumber !== null) {
    const block = await base.getBlock({ blockNumber: tx3.blockNumber });
    tx3.timestamp = Number(block.timestamp);
  }

  // ---------------------------------------------------------------------------------------
  // Tx2 — the callback that asked for this sweep
  //
  // The payload is decoded and matched against what the sweep actually moved. Among identical
  // payloads (two runs, same burner, same amount) the callback closest in time to the sweep
  // wins. This is the same rule the ledger uses; the callback is not "the latest one for the
  // burner", which is what let a newer run's callback attach to an older run's sweep.
  // ---------------------------------------------------------------------------------------
  const reactiveHead = await withRpcRetry("reactive head", () => reactive.getBlockNumber());
  const reactiveFloor = reactiveHead > 20_000n ? reactiveHead - 20_000n : 0n;

  let callbacks: Log<bigint, number, false, typeof CALLBACK_REQUEST, true>[] = [];
  for (const from of [reactiveFloor, 0n]) {
    try {
      callbacks = await withRpcRetry("callback logs", () =>
        reactive.getLogs({
          address: SYSTEM_CONTRACT,
          event: CALLBACK_REQUEST,
          args: { recipient: forwarder },
          fromBlock: from,
          toBlock: reactiveHead,
        }),
      );
      break;
    } catch {
      callbacks = [];
    }
  }

  let tx2: LegResult = { found: false, txHash: null, blockNumber: null, timestamp: null, detail: "no CallbackRequest for this burner" };

  if (sweep && tx3.timestamp !== null) {
    const sweepColdWallet = sweep.args.coldWallet;
    const matches: { log: (typeof callbacks)[number]; decoded: DecodedSweepRequest }[] = [];
    for (const log of callbacks) {
      const decoded = decodeCallbackRequest(log.args.configuration!);
      if (
        decoded &&
        same(decoded.token, token) &&
        same(decoded.burner, burner) &&
        same(decoded.coldWallet, sweepColdWallet) &&
        decoded.amount === (sweep.args.amount ?? 0n)
      ) {
        matches.push({ log, decoded });
      }
    }

    const timed = await Promise.all(
      matches.map(async (entry) => {
        const block = await reactive.getBlock({ blockNumber: entry.log.blockNumber! });
        return { ...entry, timestamp: Number(block.timestamp) };
      }),
    );
    const nearest = timed
      .map((entry) => ({ ...entry, delta: Math.abs(entry.timestamp - tx3.timestamp!) }))
      .filter((entry) => entry.delta <= CALLBACK_WINDOW_SECONDS)
      .sort((a, b) => a.delta - b.delta)[0];

    if (nearest) {
      tx2 = {
        found: true,
        txHash: nearest.log.transactionHash!,
        blockNumber: nearest.log.blockNumber!,
        timestamp: nearest.timestamp,
        detail: `callback payload matches the sweep (${nearest.delta}s apart)`,
      };
    } else if (matches.length > 0) {
      tx2 = {
        found: false,
        txHash: null,
        blockNumber: null,
        timestamp: null,
        detail: `found ${matches.length} matching callback(s), but none within ${CALLBACK_WINDOW_SECONDS}s of the sweep`,
      };
    }
  }

  const latency =
    tx1.timestamp !== null && tx3.timestamp !== null ? tx3.timestamp - tx1.timestamp : null;
  const complete = tx1.found && tx2.found && tx3.found;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          complete,
          symbol,
          decimals: Number(decimals),
          // The chain ids the nodes actually reported. `e2e-demo.sh` writes them into
          // docs/proof/latest.json, so a proof file can never claim a chain the run did
          // not happen on.
          originChainId,
          reactiveChainId,
          originExplorer,
          reactiveExplorer,
          latencySeconds: latency,
          legs: {
            tx1: { ...tx1, blockNumber: tx1.blockNumber?.toString() ?? null },
            tx2: { ...tx2, blockNumber: tx2.blockNumber?.toString() ?? null },
            tx3: { ...tx3, blockNumber: tx3.blockNumber?.toString() ?? null },
          },
        },
        null,
        2,
      ),
    );
  } else {
    const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
    const row = (label: string, leg: LegResult, explorer: string) => {
      const link = leg.txHash ? `${explorer}/tx/${leg.txHash}` : "—";
      console.log(`${mark(leg.found)}  ${label.padEnd(14)} ${leg.detail}`);
      if (leg.txHash) console.log(`      ${link}`);
    };

    row("Tx1 deposit", tx1, originExplorer);
    row("Tx2 reactive", tx2, reactiveExplorer);
    row("Tx3 sweep", tx3, originExplorer);
    console.log("");
    if (latency !== null) {
      console.log(`latency      ${latency}s (tx1 block time → tx3 block time)`);
    }
    console.log(`result       ${complete ? "LOOP VERIFIED" : "INCOMPLETE"}`);

    if (complete && sweep) {
      const swept = sweep.args.amount ?? 0n;
      console.log("");
      console.log(`deposited    ${formatUnits(depositAmount, Number(decimals))} ${symbol}`);
      console.log(`swept        ${formatUnits(swept, Number(decimals))} ${symbol}`);
      console.log(`burner bal   ${formatUnits(await base.readContract({
        address: token,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [burner],
      }) as bigint, Number(decimals))} ${symbol} (should be ~0)`);
    }
  }

  process.exit(complete ? 0 : 1);
}

main().catch((error) => {
  console.error("verify-sweep failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
