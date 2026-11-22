import { parseAbiItem, type Log } from "viem";
import { erc20Abi } from "@/config/abis";
import type { Address } from "@/domain/burner-route";
import { getBaseClient, getReactiveClient } from "./rpc-clients";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const tokensSweptEvent = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);

export const baseSepoliaClient = getBaseClient;
export const reactiveClient = getReactiveClient;

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
