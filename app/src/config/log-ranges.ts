/**
 * How many blocks one `eth_getLogs` request may cover, per chain.
 *
 * Nodes do not agree on a limit: Reactive Lasna rejects anything above 29,999 blocks
 * ("getLogs request exceeded max allowed range") while the Base Sepolia gateway accepts
 * 5,000,000 without complaint. A span above the node's cap does not fail loudly — it triggers
 * the bisect fallback, which spends a request discovering the limit on *every* scan. That is
 * where the ledger's cold-build latency comes from: five rejected requests before the first one
 * fits, repeated on every rebuild. Hence one measured value per chain, never a shared constant.
 *
 * The numbers below were measured against the live endpoints, not guessed:
 *
 *   - Lasna (5318007): 29,999 accepted, 30,000 rejected. The chunk is the measured maximum.
 *   - Base Sepolia (84532): 5,000,000 accepted (~2.5 s, 21 logs). The cap is far higher than
 *     any window SAPU scans, so the chunk here is a *chosen* value rather than the limit:
 *     it is small enough that one chunk is a bounded response, and fine enough that the
 *     sliding scan leaves most chunks settled in the cache instead of re-fetching one huge
 *     tip chunk on every poll.
 *
 * Every other chain falls back to `FALLBACK_CHUNK_BLOCKS`, which is deliberately below any cap
 * seen in the wild (public providers commonly cap at 10,000 or lower). A chain whose provider
 * is tighter than that still works: `logs.ts` bisects the rejected range once and remembers
 * the working size per chain for the rest of the process, so the cost is paid once rather than
 * on every scan. Chains are not listed here with invented values — an unmeasured chain gets
 * the conservative fallback, not a number that looks plausible.
 */

const CHUNK_BLOCKS: Readonly<Record<number, number>> = {
  // Measured: 29,999 accepted, 30,000 rejected.
  5318007: 29_999,
  // Measured cap is >= 5,000,000; this is a chosen chunk, not the limit. See above.
  84532: 100_000,
};

/** Below every per-chain cap observed so far, so an unmeasured chain never wastes a request. */
const FALLBACK_CHUNK_BLOCKS = 10_000n;

/**
 * Chunk size for one chain.
 *
 * `null` means the chain of the client could not be determined (a test double, or a client
 * created outside `rpc-clients.ts`); the conservative fallback applies. Returning a guess
 * here would be worse than being slow.
 */
export function logChunkBlocks(chainId: number | null): bigint {
  if (chainId === null) return FALLBACK_CHUNK_BLOCKS;
  const configured = CHUNK_BLOCKS[chainId];
  return configured === undefined ? FALLBACK_CHUNK_BLOCKS : BigInt(configured);
}
