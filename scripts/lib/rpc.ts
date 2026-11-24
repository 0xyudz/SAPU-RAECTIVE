import { fallback, http, type PublicClient, type Transport } from "viem";

/**
 * Transport failures worth retrying.
 *
 * The status codes are `\b`-delimited for the reason documented in the app's
 * `infrastructure/rpc-retry.ts`: a bare `429` also matches the hex of an address inside viem's
 * error message, which classified a permanent "account.signTransaction is not a function" as a
 * rate limit and retried it six times.
 */
const TRANSIENT_PATTERN =
  /\b429\b|too many requests|rate limit|exceeds defined limit|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|\b50[234]\b|bad gateway|service unavailable/i;

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

/**
 * Transport for a signer.
 *
 * Accepts the same fallback list as `rpcTransport`. Failing over mid-send is safe here because
 * every retry re-signs the *same* `(nonce, to, value, gas, chain)` tuple: the bytes are identical,
 * so whichever endpoint accepts them broadcasts the same transaction hash and exactly one
 * transaction exists. That is the property `sendWithReconcile` relies on, and without it a single
 * endpoint answering 429 in a burst would end a run that had nothing wrong with it.
 */
export function signerTransport(primary: string, fallbacks: string[] = []): Transport {
  const urls = [...new Set([...splitUrls(primary), ...fallbacks.flatMap(splitUrls)])];
  const transports = urls.map((url) => http(url, { timeout: 60_000, retryCount: 0 }));
  if (transports.length === 1) return transports[0]!;
  return fallback(transports, { rank: false, retryCount: 1 });
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

  // Sends are signed deterministically: re-signing the same `(nonce, to, value, gas, chain)`
  // produces the same bytes and therefore the same hash. When a lagging endpoint reports a
  // stale `pending` nonce, the retry can re-broadcast a transaction that was already mined and
  // the node may answer with that old hash. Returning it would make the caller believe a new
  // deposit landed and hand a stale block to the verifier — exactly how a proof ends up
  // pairing one run's deposit with another run's callback. Anything mined before this call
  // started is a replay, not this send.
  const startedAtBlock = await withRpcRetry("send head", () => ctx.client.getBlockNumber()).catch(
    () => null,
  );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = await ctx.client.getTransactionCount({
      address: ctx.address,
      blockTag: "pending",
    });

    try {
      const hash = await send(nonce);

      if (startedAtBlock !== null) {
        const mined = await ctx.client.getTransaction({ hash }).catch(() => null);
        if (mined && mined.blockNumber !== null && mined.blockNumber < startedAtBlock) {
          const replay = new Error(
            `${label}: ${hash} was already mined at block ${mined.blockNumber} before this send (replay of nonce ${nonce})`,
          );
          lastError = replay;
          console.warn(`  ${label}: ${replay.message}; retrying`);
          await sleep(delay);
          delay = Math.min(Math.round(delay * 1.5), 20_000);
          continue;
        }
      }

      return hash;
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
