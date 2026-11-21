import { createPublicClient, http, parseAbiItem, type PublicClient, type Log } from "viem";
import {
  BASE_SEPOLIA,
  REACTIVE_LASNA,
  TRANSFER_TOPIC_0,
  TOKENS_SWEPT_TOPIC_0,
} from "@/config/chains";
import { erc20Abi, sapuForwarderAbi, sapuRscAbi } from "@/config/abis";
import type { Address } from "@/domain/burner-route";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

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

export async function getBaseSepoliaBlockNumber(): Promise<bigint> {
  return baseSepoliaClient().getBlockNumber();
}

export async function getReactiveBlockNumber(): Promise<bigint> {
  return reactiveClient().getBlockNumber();
}

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

export async function getTokenBalance(token: Address, account: Address): Promise<bigint> {
  return baseSepoliaClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}

export async function getTokenDecimals(token: Address): Promise<number> {
  const decimals = (await baseSepoliaClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  return Number(decimals);
}

export async function getTokenSymbol(token: Address): Promise<string> {
  return baseSepoliaClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "symbol",
  }) as Promise<string>;
}

export async function getRoute(params: { rsc: Address; token: Address; burner: Address }) {
  return reactiveClient().readContract({
    address: params.rsc,
    abi: sapuRscAbi,
    functionName: "routeOf",
    args: [params.token, params.burner],
  });
}

export async function getForwarderRule(params: { forwarder: Address; token: Address; burner: Address }) {
  return baseSepoliaClient().readContract({
    address: params.forwarder,
    abi: sapuForwarderAbi,
    functionName: "ruleOf",
    args: [params.token, params.burner],
  });
}

export async function getSweepCount(forwarder: Address): Promise<bigint> {
  return baseSepoliaClient().readContract({
    address: forwarder,
    abi: sapuForwarderAbi,
    functionName: "sweepCount",
  }) as Promise<bigint>;
}

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

export function padAddress(address: Address): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as `0x${string}`;
}

export function topicToAddress(topic: `0x${string}`): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address;
}

export const TOPICS = { TRANSFER_TOPIC_0, TOKENS_SWEPT_TOPIC_0 } as const;
