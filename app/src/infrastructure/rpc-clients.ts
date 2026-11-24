import { createPublicClient, http, type PublicClient } from "viem";
import { chainById, readDeploymentConfig } from "@/config/chains";
import { rpcOverride } from "@/config/chain-rpc";

const TRANSPORT = {
  timeout: 30_000,
  retryCount: 0,
} as const;

/**
 * One client per chain, created on first use.
 *
 * `createPublicClient` without an explicit `chain` is intentional: SAPU talks to whatever
 * endpoint the operator configured, and the chain id it *believes* it is talking to comes
 * from `config/chains.ts`. Attaching viem's built-in chain definition would add a second,
 * silently-diverging source of truth for chain ids.
 */
const clients = new Map<number, PublicClient>();

/**
 * Which chain each client talks to, keyed by viem's `uid`.
 *
 * `logs.ts` needs the chain id to pick a chunk size that fits that node's `eth_getLogs` cap.
 * Keeping the mapping here — next to the only place a client is created — means no caller has
 * to pass a chain id along, so a new log-scanning call site cannot silently fall back to the
 * wrong (or the conservative) chunk size.
 */
const clientChainIds = new Map<string, number>();

/** Chain id for a client created by `getClient`, or `null` for a client built elsewhere. */
export function chainIdForClient(client: PublicClient): number | null {
  return clientChainIds.get(client.uid) ?? null;
}

/**
 * Public client for a chain.
 *
 * Throws when no RPC endpoint is configured. Callers that can degrade (a batch read, a
 * health probe) already catch and report `null`; the ones that cannot (a write) should
 * fail loudly rather than be pointed at a guessed endpoint.
 */
export function getClient(chainId: number): PublicClient {
  const existing = clients.get(chainId);
  if (existing !== undefined) return existing;

  const url = rpcOverride(chainId);
  if (url === null) {
    const chain = chainById(chainId);
    throw new Error(
      `No RPC endpoint configured for ${chain?.name ?? `chain ${chainId}`} (${chainId}). ` +
        `Set NEXT_PUBLIC_RPC_URL_${chainId} in app/.env.local.`,
    );
  }

  const client = createPublicClient({ transport: http(url, TRANSPORT) });
  clients.set(chainId, client);
  clientChainIds.set(client.uid, chainId);
  return client;
}

/** Client for the deployment's token chain (event source and sweep destination). */
export function getOriginClient(): PublicClient {
  return getClient(readDeploymentConfig().origin.id);
}

/** Client for the Reactive chain that executes `SapuRSC`. */
export function getReactiveClient(): PublicClient {
  return getClient(readDeploymentConfig().reactive.id);
}
