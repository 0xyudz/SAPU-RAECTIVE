import type { Address } from "@/domain/burner-route";
import { erc20Abi } from "@/config/abis";
import { decode, encode, multicall, type Call3 } from "./multicall";

/**
 * Live ERC-20 balances for a set of burners.
 *
 * Batched through multicall so one page load does not fan out into N `eth_call`
 * requests. A failed sub-call is reported as `null`, never as zero: a zero balance
 * and an unreadable balance are different claims and the ledger must not conflate
 * them.
 */
export type BalanceReads = ReadonlyMap<Address, bigint | null>;

function balanceCall(token: Address, holder: Address): Call3 {
  return {
    target: token,
    callData: encode(erc20Abi, "balanceOf", [holder]),
  };
}

export async function readTokenBalances(
  token: Address,
  holders: readonly Address[],
): Promise<BalanceReads> {
  const unique = [...new Set(holders.map((holder) => holder.toLowerCase() as Address))];
  const out = new Map<Address, bigint | null>();
  if (unique.length === 0) return out;

  const raw = await multicall(
    unique.map((holder) => balanceCall(token, holder)),
    "base",
  );

  for (const [index, holder] of unique.entries()) {
    const data = raw[index];
    if (data === undefined || data === null) {
      out.set(holder, null);
      continue;
    }
    try {
      out.set(holder, decode<bigint>(erc20Abi, "balanceOf", data));
    } catch {
      out.set(holder, null);
    }
  }

  return out;
}
