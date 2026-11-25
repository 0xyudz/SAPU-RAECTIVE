import type { Address } from "@/domain/burner-route";
import { erc20Abi } from "@/config/abis";
import { decode, encode, multicall, type Call3 } from "./multicall";

/**
 * Symbol and decimals for one token, as read from the chain.
 *
 * Both fields are nullable because a token is not obliged to implement them. A non-standard
 * ERC-20 can omit `symbol`, return `bytes32` instead of `string`, or revert outright. When
 * that happens the ledger must not invent a ticker: it reports the token by address and shows
 * raw base units, which is ugly but true.
 */
export interface TokenMetadata {
  readonly address: Address;
  readonly symbol: string | null;
  readonly decimals: number | null;
}

export type TokenMetadataMap = ReadonlyMap<Address, TokenMetadata>;

function symbolCall(token: Address): Call3 {
  return { target: token, callData: encode(erc20Abi, "symbol", []) };
}

function decimalsCall(token: Address): Call3 {
  return { target: token, callData: encode(erc20Abi, "decimals", []) };
}

/**
 * Reads metadata for several tokens in one batch per chain.
 *
 * Never from `NEXT_PUBLIC_SAPU_TOKEN_*`: that is only correct while a deployment has exactly one
 * token, and it silently mislabels every row the moment a second token exists — the ledger would
 * print token B's amounts under token A's ticker and decimals. Reading it from the contract itself
 * removes the chance to disagree with the chain.
 *
 * Symbols and decimals are requested together in a single `aggregate3`, so N tokens cost one
 * request per chain rather than 2N.
 */
export async function readTokenMetadata(
  tokens: readonly Address[],
  chainId: number,
): Promise<TokenMetadataMap> {
  const unique = [...new Set(tokens.map((token) => token.toLowerCase() as Address))];
  const out = new Map<Address, TokenMetadata>();
  if (unique.length === 0) return out;

  const calls: Call3[] = [];
  for (const token of unique) {
    calls.push(symbolCall(token), decimalsCall(token));
  }

  let raw: readonly (`0x${string}` | null)[] = unique.map(() => null);
  try {
    raw = await multicall(calls, chainId);
  } catch {
    // A total failure leaves every entry null, which is reported as "unreadable" rather than
    // as a token with no symbol. The distinction matters: one is a transport fault, the other
    // is a property of the contract.
    raw = unique.map(() => null);
  }

  for (const [index, token] of unique.entries()) {
    const symbolData = raw[index * 2] ?? null;
    const decimalsData = raw[index * 2 + 1] ?? null;

    let symbol: string | null = null;
    if (symbolData !== null && symbolData !== "0x") {
      try {
        const decoded = decode<string>(erc20Abi, "symbol", symbolData);
        if (typeof decoded === "string" && decoded.trim().length > 0) symbol = decoded.trim();
      } catch {
        // `bytes32` symbols and reverting implementations land here; the token keeps a null
        // symbol and the UI falls back to its address.
      }
    }

    let decimals: number | null = null;
    if (decimalsData !== null && decimalsData !== "0x") {
      try {
        const decoded = decode<bigint | number>(erc20Abi, "decimals", decimalsData);
        const asNumber = Number(decoded);
        if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 36) decimals = asNumber;
      } catch {
        // Unreadable decimals must not be guessed at 18: that would misstate every amount.
      }
    }

    out.set(token, { address: token, symbol, decimals });
  }

  return out;
}
