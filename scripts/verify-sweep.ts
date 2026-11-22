#!/usr/bin/env node

import {
  createPublicClient,
  parseAbiItem,
  formatUnits,
  parseAbi,
  decodeAbiParameters,
  type Log,
} from "viem";
import { config as loadEnv } from "dotenv";

import { rpcTransport, withRpcRetry, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";

loadEnv({ quiet: true });

const BASE_SEPOLIA_CHAIN_ID = 84532;
const REACTIVE_LASNA_CHAIN_ID = 5318007;
const SYSTEM_CONTRACT = "0x8888888888888888888888888888888888888888" as const;

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
  return {
    fromBlock: fromBlockRaw ? BigInt(fromBlockRaw) : 0n,
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

  const startBlock = options.fromBlock > 0n ? options.fromBlock : await base.getBlockNumber();

  if (!options.json) {
    console.log("== SAPU :: loop verification ==");
    console.log(`token        ${symbol} ${token}`);
    console.log(`burner       ${burner}`);
    console.log(`forwarder    ${forwarder}`);
    console.log(`from block   ${startBlock}`);
    console.log("");
  }

  const deposits = await withRpcRetry("deposit logs", () =>
    base.getLogs({
      address: token,
      event: TRANSFER,
      args: { to: burner },
      fromBlock: startBlock,
      toBlock: "latest",
    }),
  );

  const tx1: LegResult = deposits.length > 0
    ? {
        found: true,
        txHash: deposits[0]!.transactionHash!,
        blockNumber: deposits[0]!.blockNumber!,
        timestamp: null,
        detail: `${deposits.length} deposit(s); first ${formatUnits(deposits[0]!.args.value ?? 0n, Number(decimals))} ${symbol}`,
      }
    : { found: false, txHash: null, blockNumber: null, timestamp: null, detail: "no Transfer into burner" };

  if (tx1.blockNumber !== null) {
    const block = await base.getBlock({ blockNumber: tx1.blockNumber });
    tx1.timestamp = Number(block.timestamp);
  }

  let sweeps: Log<bigint, number, false, typeof TOKENS_SWEPT, true>[] = [];
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  if (tx1.found) {
    if (!options.json) process.stdout.write("waiting for Tx3 sweep");
    while (Date.now() < deadline) {
      sweeps = await withRpcRetry("sweep logs", () =>
        base.getLogs({
          address: forwarder,
          event: TOKENS_SWEPT,
          args: { burner },
          fromBlock: startBlock,
          toBlock: "latest",
        }),
      );
      if (sweeps.length > 0) break;
      if (!options.json) process.stdout.write(".");
      await sleep(3_000);
    }
    if (!options.json) process.stdout.write("\n\n");
  }

  const tx3: LegResult = sweeps.length > 0
    ? {
        found: true,
        txHash: sweeps[0]!.transactionHash!,
        blockNumber: sweeps[0]!.blockNumber!,
        timestamp: null,
        detail: `${formatUnits(sweeps[0]!.args.amount ?? 0n, Number(decimals))} ${symbol} swept`,
      }
    : {
        found: false,
        txHash: null,
        blockNumber: null,
        timestamp: null,
        detail: tx1.found ? "no TokensSwept within timeout" : "skipped (no deposit)",
      };

  if (tx3.blockNumber !== null) {
    const block = await base.getBlock({ blockNumber: tx3.blockNumber });
    tx3.timestamp = Number(block.timestamp);
  }

  let callbacks: Log<bigint, number, false, typeof CALLBACK_REQUEST, true>[] = [];
  const reactiveHead = await withRpcRetry("reactive head", () => reactive.getBlockNumber());
  const reactiveFloor = reactiveHead > 20_000n ? reactiveHead - 20_000n : 0n;

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

  const tx2Candidates = callbacks.filter((log) =>
    (log.args.configuration ?? "").toLowerCase().includes(burner.slice(2).toLowerCase()),
  );
  const tx2Log = tx2Candidates[tx2Candidates.length - 1] ?? null;

  const tx2: LegResult = tx2Log !== null
    ? {
        found: true,
        txHash: tx2Log.transactionHash!,
        blockNumber: tx2Log.blockNumber!,
        timestamp: null,
        detail: `callback payload names burner ${burner}`,
      }
    : { found: false, txHash: null, blockNumber: null, timestamp: null, detail: "no CallbackRequest for this burner" };

  if (tx2.blockNumber !== null) {
    const block = await reactive.getBlock({ blockNumber: tx2.blockNumber });
    tx2.timestamp = Number(block.timestamp);
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

    row("Tx1 deposit", tx1, "https://sepolia.basescan.org");
    row("Tx2 reactive", tx2, "https://lasna.reactscan.net");
    row("Tx3 sweep", tx3, "https://sepolia.basescan.org");

    console.log("");
    if (latency !== null) {
      console.log(`latency      ${latency}s (tx1 block time → tx3 block time)`);
    }
    console.log(`result       ${complete ? "LOOP VERIFIED" : "INCOMPLETE"}`);

    if (complete) {
      const swept = sweeps[0]!.args.amount ?? 0n;
      const deposited = deposits[0]!.args.value ?? 0n;
      console.log("");
      console.log(`deposited    ${formatUnits(deposited, Number(decimals))} ${symbol}`);
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
