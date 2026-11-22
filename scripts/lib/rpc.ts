import { fallback, http, type PublicClient, type Transport } from "viem";

const TRANSIENT_PATTERN =
  /429|too many requests|rate limit|exceeds defined limit|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|502|503|504|bad gateway|service unavailable/i;

const NONCE_PATTERN =
  /nonce too low|nonce provided for the transaction is lower|already known|replacement transaction underpriced/i;

function matches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const parts = [record.message, record.shortMessage, record.details];
    if (parts.some((part) => typeof part === "string" && pattern.test(part))) return true;
    if (typeof record.status === "number" && (record.status === 429 || record.status >= 500)) {
      return pattern === TRANSIENT_PATTERN;
    }
    current = record.cause;
  }

  return false;
}

export const isTransientRpcError = (error: unknown): boolean => matches(error, TRANSIENT_PATTERN);
export const isNonceConflict = (error: unknown): boolean => matches(error, NONCE_PATTERN);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRpcRetry<T>(
  label: string,
  action: () => Promise<T>,
  attempts = 6,
): Promise<T> {
  let delay = 1_000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !isTransientRpcError(error)) throw error;
      console.warn(`  ${label}: transient RPC error (attempt ${attempt}/${attempts}), retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 20_000);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

function splitUrls(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function rpcTransport(primary: string, fallbacks: string[] = []): Transport {
  const urls = [...new Set([...splitUrls(primary), ...fallbacks.flatMap(splitUrls)])];
  const transports = urls.map((url) => http(url, { timeout: 30_000, retryCount: 2, retryDelay: 800 }));
  if (transports.length === 1) return transports[0]!;
  return fallback(transports, { rank: false, retryCount: 1 });
}

export function signerTransport(primary: string): Transport {
  return http(splitUrls(primary)[0]!, { timeout: 60_000, retryCount: 0 });
}

export const BASE_SEPOLIA_FALLBACKS = [
  "https://base-sepolia.api.onfinality.io/public",
  "https://base-sepolia.gateway.tenderly.co",
];

export const REACTIVE_FALLBACKS = ["https://lasna-rpc.rnk.dev/"];

export interface SignerContext {
  readonly client: PublicClient;
  readonly address: `0x${string}`;
}

async function findMinedHash(ctx: SignerContext, nonce: number): Promise<`0x${string}` | null> {
  const head = await ctx.client.getBlockNumber();
  const floor = head > 40n ? head - 40n : 0n;

  for (let number = head; number >= floor; number -= 1n) {
    const block = await ctx.client.getBlock({ blockNumber: number, includeTransactions: true });
    for (const tx of block.transactions) {
      if (
        typeof tx === "object" &&
        tx.from.toLowerCase() === ctx.address.toLowerCase() &&
        tx.nonce === nonce
      ) {
        return tx.hash;
      }
    }
    if (number === 0n) break;
  }

  return null;
}

export async function sendWithReconcile(
  label: string,
  send: (nonce: number) => Promise<`0x${string}`>,
  ctx: SignerContext,
  attempts = 8,
): Promise<`0x${string}`> {
  let delay = 2_000;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = await ctx.client.getTransactionCount({
      address: ctx.address,
      blockTag: "pending",
    });

    try {
      return await send(nonce);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || (!isTransientRpcError(error) && !isNonceConflict(error))) break;

      console.warn(`  ${label}: ${describe(error)} (attempt ${attempt}/${attempts})`);
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 20_000);

      const confirmed = await ctx.client
        .getTransactionCount({ address: ctx.address, blockTag: "latest" })
        .catch(() => 0);
      if (confirmed > nonce) {
        const recovered = await findMinedHash(ctx, nonce).catch(() => null);
        if (recovered) {
          console.warn(`  ${label}: broadcast landed as ${recovered}`);
          return recovered;
        }
      }
      console.warn(`  ${label}: nothing mined at nonce ${nonce}, retrying`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}
