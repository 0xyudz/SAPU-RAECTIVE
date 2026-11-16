/**
 * Infrastructure: BaseSepoliaClient
 *
 * Thin, typed wrapper over `viem` public clients for the two chains SAPU touches.
 * All chain reads go through here so that the application layer never imports
 * `viem` directly and the whole chain surface stays swappable and mockable.
 */

import { createPublicClient, http, parseAbiItem, type PublicClient, type Log } from "viem";
import {
  BASE_SEPOLIA,
  REACTIVE_LASNA,
  TRANSFER_TOPIC_0,
  TOKENS_SWEPT_TOPIC_0,
} from "@/config/chains";
import { erc20Abi, sapuForwarderAbi, sapuRscAbi } from "@/config/abis";
import type { Address } from "@/domain/burner-route";

/**
 * `Transfer(address indexed from, address indexed to, uint256 value)`
 * Declared as an ABI item so viem can filter on indexed arguments natively rather
 * than by hand-padding topics. The `to` argument *is* topic_2 — the same position the
 * RSC subscribes on.
 */
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** `TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)` */
const tokensSweptEvent = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);

export function baseSepoliaClient(): PublicClient {
  return createPublicClient({
    transport: http(BASE_SEPOLIA.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
}

export function reactiveClient(): PublicClient {
  return createPublicClient({
    transport: http(REACTIVE_LASNA.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
}

/** A normalised log, decoupled from viem's generic `Log` shape. */
export interface NormalizedLog {
  readonly address: Address;
  readonly txHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
}

function normalize(log: Log): NormalizedLog {
  if (log.transactionHash === null || log.blockNumber === null || log.logIndex === null) {
    throw new Error("Encountered a pending log; SAPU only reads mined logs.");
  }
  return {
    address: log.address.toLowerCase() as Address,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    topics: log.topics,
    data: log.data,
  };
}

/** Current block height on Base Sepolia. */
export async function getBaseSepoliaBlockNumber(): Promise<bigint> {
  return baseSepoliaClient().getBlockNumber();
}

/** Current block height on Reactive Lasna. */
export async function getReactiveBlockNumber(): Promise<bigint> {
  return reactiveClient().getBlockNumber();
}

/**
 * Finds ERC-20 `Transfer` logs into `burner` for `token`, in a block range.
 *
 * `args: { to: burner }` constrains topic_2, which is precisely what the RSC's
 * subscription does on Reactive Network — so the watcher observes the same events the
 * reactive contract reacts to.
 */
export async function findDeposits(params: {
  token: Address;
  burner: Address;
  fromBlock: bigint;
  toBlock: bigint | "latest";
}): Promise<NormalizedLog[]> {
  const logs = await baseSepoliaClient().getLogs({
    address: params.token,
    event: transferEvent,
    args: { to: params.burner },
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
  });
  return logs.map(normalize);
}

/** Finds `TokensSwept` logs emitted by the forwarder. */
export async function findSweeps(params: {
  forwarder: Address;
  burner?: Address;
  fromBlock: bigint;
  toBlock: bigint | "latest";
}): Promise<NormalizedLog[]> {
  const logs = await baseSepoliaClient().getLogs({
    address: params.forwarder,
    event: tokensSweptEvent,
    args: params.burner ? { burner: params.burner } : {},
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
  });
  return logs.map(normalize);
}

/** ERC-20 balance of `account`, in base units. */
export async function getTokenBalance(token: Address, account: Address): Promise<bigint> {
  return baseSepoliaClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}

/** Token decimals. */
export async function getTokenDecimals(token: Address): Promise<number> {
  const decimals = (await baseSepoliaClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  return Number(decimals);
}

/** Token symbol. */
export async function getTokenSymbol(token: Address): Promise<string> {
  return baseSepoliaClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "symbol",
  }) as Promise<string>;
}

/** Reads the armed route for (token, burner) from the RSC on Reactive Lasna. */
export async function getRoute(params: { rsc: Address; token: Address; burner: Address }) {
  return reactiveClient().readContract({
    address: params.rsc,
    abi: sapuRscAbi,
    functionName: "routeOf",
    args: [params.token, params.burner],
  });
}

/** Reads the forwarder's armed rule for (token, burner). */
export async function getForwarderRule(params: { forwarder: Address; token: Address; burner: Address }) {
  return baseSepoliaClient().readContract({
    address: params.forwarder,
    abi: sapuForwarderAbi,
    functionName: "ruleOf",
    args: [params.token, params.burner],
  });
}

/** Forwarder's lifetime sweep counter. */
export async function getSweepCount(forwarder: Address): Promise<bigint> {
  return baseSepoliaClient().readContract({
    address: forwarder,
    abi: sapuForwarderAbi,
    functionName: "sweepCount",
  }) as Promise<bigint>;
}

/** Fetches a block timestamp, with a small cache to avoid repeat RPC calls. */
const timestampCache = new Map<string, number>();

export async function getBlockTimestamp(chain: "base" | "reactive", blockNumber: bigint): Promise<number> {
  const key = `${chain}:${blockNumber}`;
  const cached = timestampCache.get(key);
  if (cached !== undefined) return cached;

  const client = chain === "base" ? baseSepoliaClient() : reactiveClient();
  const block = await client.getBlock({ blockNumber });
  const ts = Number(block.timestamp);
  timestampCache.set(key, ts);
  return ts;
}

/** Left-pads an address into a 32-byte topic. */
export function padAddress(address: Address): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as `0x${string}`;
}

/** Extracts the low 20 bytes of a 32-byte topic as an address. */
export function topicToAddress(topic: `0x${string}`): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address;
}

/** Re-exported so callers can assert the topic constants match the parsed ABI. */
export const TOPICS = { TRANSFER_TOPIC_0, TOKENS_SWEPT_TOPIC_0 } as const;
