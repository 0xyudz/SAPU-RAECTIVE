import { parseAbiItem, type Log, type PublicClient } from "viem";
import { erc20Abi } from "@/config/abis";
import { readDeploymentConfig } from "@/config/chains";
import type { Address } from "@/domain/burner-route";
import { getDecodedLogs } from "./logs";
import { getClient, getOriginClient } from "./rpc-clients";
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const tokensSweptEvent = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);

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

/**
 * Reads on the token chain.
 *
 * Every function here takes the chain it should read implicitly from the deployment
 * config (`origin`), so a deployment pointed at another Reactive-supported chain keeps
 * working without a code change. Nothing in this module names a specific chain.
 */
export async function getOriginBlockNumber(): Promise<bigint> {
  return getOriginClient().getBlockNumber();
}

export async function findDeposits(params: {
  token: Address;
  burner: Address;
  fromBlock: bigint;
  toBlock: bigint | "latest";
}): Promise<NormalizedLog[]> {
  const client = getOriginClient();
  const logs = await getDecodedLogs<Log>({
    client,
    address: params.token,
    event: transferEvent,
    args: { to: params.burner },
    fromBlock: params.fromBlock,
    toBlock: params.toBlock === "latest" ? await client.getBlockNumber() : params.toBlock,
    cacheKeySuffix: "deposits",
  });
  return logs.map(normalize);
}

export async function findSweeps(params: {
  forwarder: Address;
  burner?: Address;
  fromBlock: bigint;
  toBlock: bigint | "latest";
}): Promise<NormalizedLog[]> {
  const client = getOriginClient();
  const logs = await getDecodedLogs<Log>({
    client,
    address: params.forwarder,
    event: tokensSweptEvent,
    args: params.burner ? { burner: params.burner } : {},
    fromBlock: params.fromBlock,
    toBlock: params.toBlock === "latest" ? await client.getBlockNumber() : params.toBlock,
    cacheKeySuffix: "sweeps",
  });
  return logs.map(normalize);
}

export async function getTokenDecimals(token: Address): Promise<number> {
  const decimals = (await getOriginClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  return Number(decimals);
}

export async function getTokenSymbol(token: Address): Promise<string> {
  return getOriginClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "symbol",
  }) as Promise<string>;
}

const timestampCache = new Map<string, number>();

/**
 * Timestamps are immutable, so entries never go stale — but the key is
 * `chainId:blockNumber`, and a long-lived process sees new blocks forever. Bounded so the
 * cache cannot grow without limit; evicting only costs one `getBlock`.
 */
const TIMESTAMP_CACHE_MAX = 512;

/**
 * Block timestamp from whichever side of the deployment the block belongs to.
 *
 * Cached per `chainId:block` so a ledger row and a sweep row that share a block cost one
 * request. The key includes the chain id because block numbers collide across chains.
 */
export async function getBlockTimestamp(chain: "origin" | "reactive", blockNumber: bigint): Promise<number> {
  const config = readDeploymentConfig();
  const chainId = chain === "origin" ? config.origin.id : config.reactive.id;
  const key = `${chainId}:${blockNumber}`;
  const cached = timestampCache.get(key);
  if (cached !== undefined) return cached;

  const client: PublicClient = chain === "origin" ? getClient(config.origin.id) : getClient(config.reactive.id);
  const block = await client.getBlock({ blockNumber });
  const ts = Number(block.timestamp);
  if (timestampCache.size >= TIMESTAMP_CACHE_MAX) {
    const oldest = timestampCache.keys().next();
    if (oldest.done !== true) timestampCache.delete(oldest.value);
  }
  timestampCache.set(key, ts);
  return ts;
}
