import type { Address } from "@/domain/burner-route";
import { pairKey, type TokenBurnerPair } from "@/domain/pair-key";
import { erc20Abi } from "@/config/abis";
import { readDeploymentConfig } from "@/config/chains";
import { decode, encode, multicall } from "./multicall";

/**
 * Live ERC-20 reads, keyed by (token, burner).
 *
 * ## Why the key is the pair and not the burner
 *
 * A burner can hold more than one token. The previous version took a single `token` argument
 * and a list of holders, so every read was implicitly scoped to one asset — fine for a
 * one-token demo, wrong for a deployment that watches several. Keying by the pair makes the
 * multi-token case the default instead of the exception.
 *
 * A failed sub-call is reported as `null`, never as zero: a zero balance and an unreadable
 * balance are different claims and the ledger must not conflate them.
 */
export type PairReads = ReadonlyMap<string, bigint | null>;

function uniquePairs(pairs: readonly TokenBurnerPair[]): TokenBurnerPair[] {
  const seen = new Map<string, TokenBurnerPair>();
  for (const pair of pairs) {
    const key = pairKey(pair.token, pair.burner);
    if (!seen.has(key)) {
      seen.set(key, {
        token: pair.token.toLowerCase() as Address,
        burner: pair.burner.toLowerCase() as Address,
      });
    }
  }
  return [...seen.values()];
}

async function readMany(
  pairs: readonly TokenBurnerPair[],
  chainId: number,
  encodeCall: (pair: TokenBurnerPair) => `0x${string}`,
  decodeCall: (data: `0x${string}`) => bigint,
): Promise<PairReads> {
  const list = uniquePairs(pairs);
  const out = new Map<string, bigint | null>();
  if (list.length === 0) return out;

  const raw = await multicall(
    list.map((pair) => ({ target: pair.token, callData: encodeCall(pair) })),
    chainId,
  ).catch(() => list.map(() => null));

  for (const [index, pair] of list.entries()) {
    const data = raw[index];
    if (data === undefined || data === null) {
      out.set(pairKey(pair.token, pair.burner), null);
      continue;
    }
    try {
      out.set(pairKey(pair.token, pair.burner), decodeCall(data));
    } catch {
      out.set(pairKey(pair.token, pair.burner), null);
    }
  }

  return out;
}

/** Live `balanceOf(burner)` for each pair. */
export async function readTokenBalances(
  pairs: readonly TokenBurnerPair[],
  chainId: number,
): Promise<PairReads> {
  return readMany(
    pairs,
    chainId,
    (pair) => encode(erc20Abi, "balanceOf", [pair.burner]),
    (data) => decode<bigint>(erc20Abi, "balanceOf", data),
  );
}

/**
 * Live allowance each burner granted the configured forwarder, per token.
 *
 * `null` on any failure so a broken read is never mistaken for a zero allowance. This is the
 * check arming does once and nothing repeats, which makes it the most common silent cause of
 * a stalled sweep.
 */
export async function readForwarderAllowances(
  pairs: readonly TokenBurnerPair[],
  chainId: number,
): Promise<PairReads> {
  const spender = readDeploymentConfig().forwarderAddress;
  if (spender === null) {
    const out = new Map<string, bigint | null>();
    for (const pair of uniquePairs(pairs)) out.set(pairKey(pair.token, pair.burner), null);
    return out;
  }

  return readMany(
    pairs,
    chainId,
    (pair) => encode(erc20Abi, "allowance", [pair.burner, spender]),
    (data) => decode<bigint>(erc20Abi, "allowance", data),
  );
}
