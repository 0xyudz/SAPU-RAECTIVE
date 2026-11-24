import {
  AbiDecodingDataSizeInvalidError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingSizeLimitExceededError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  IntegerOutOfRangeError,
} from "viem";
import type { Address } from "@/domain/burner-route";
import { normaliseTokenDecimals, normaliseTokenSymbol } from "@/domain/token-metadata";
import { getTokenDecimals, getTokenSymbol } from "./chain-client";
import { getOriginClient } from "./rpc-clients";
import { withRpcRetry } from "./rpc-retry";
import { reasonOf } from "./reason";

/**
 * What an arbitrary address on the origin chain says about itself as an ERC-20.
 *
 * ## Why this is a discriminated union and not `{ symbol, decimals } | null`
 *
 * "This address is not an ERC-20" and "the RPC never answered" are different claims with
 * different fixes: the first means the operator typed the wrong address, the second means the
 * node is down or rate-limited. Collapsing them into `null` would tell an operator their token
 * is broken because a public gateway returned 429 — a false claim about the chain, which is the
 * one thing this app must never make.
 *
 * ## Why `getCode` runs first
 *
 * viem's error for a non-token is ambiguous: an address with no code and a contract that lacks
 * `symbol()` both surface as `ContractFunctionExecutionError`, and a flaky node can return `0x`
 * for a perfectly good token. Reading the bytecode separates "there is nothing there" (a fact
 * about the address) from "the node did not answer" (a fact about the network), so the two are
 * never confused. This is the same code-first pattern `permit-support.ts` and
 * `rsc-capabilities.ts` use, for the same reason.
 */
export type TokenProbe =
  | { readonly kind: "read"; readonly symbol: string; readonly decimals: number }
  /** `eth_getCode` returned empty: there is no contract at this address. */
  | { readonly kind: "no-code" }
  /** There is code, but it does not answer `symbol()`/`decimals()` like an ERC-20. */
  | { readonly kind: "not-erc20"; readonly reason: string }
  /** The chain could not be read. Proves nothing about the token. */
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * Failures that prove the call reached the contract and the contract did not answer like an
 * ERC-20. Anything else — a timeout, a 429, a malformed JSON-RPC envelope — says nothing about
 * the token, so it must not be reported as one.
 *
 * The decode errors are included deliberately: a legacy token that returns `bytes32` from
 * `symbol()` (MKR and friends) reaches the contract fine and answers, it just answers in a shape
 * the `string` ABI cannot hold — viem reports that as `IntegerOutOfRangeError` or a data-size
 * error. That is a fact about the token, and the operator should see "this is not a standard
 * ERC-20 symbol" rather than a rate-limit message.
 */
function isTokenFact(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const matches = (type: abstract new (...args: never[]) => unknown) =>
    error.walk((candidate) => candidate instanceof type) !== null;

  return (
    matches(ContractFunctionRevertedError) ||
    matches(ContractFunctionZeroDataError) ||
    matches(AbiDecodingZeroDataError) ||
    matches(AbiDecodingDataSizeInvalidError) ||
    matches(AbiDecodingDataSizeTooSmallError) ||
    matches(AbiDecodingSizeLimitExceededError) ||
    matches(IntegerOutOfRangeError)
  );
}

/** Reads `symbol()`/`decimals()` for the address the operator actually typed. */
export async function probeTokenMetadata(token: Address): Promise<TokenProbe> {
  let code: string | undefined;
  try {
    code = await withRpcRetry(() => getOriginClient().getCode({ address: token }));
  } catch (error) {
    return { kind: "unreachable", reason: reasonOf(error) };
  }

  if (typeof code !== "string" || code === "0x" || code === "0x0") {
    return { kind: "no-code" };
  }

  const [symbolResult, decimalsResult] = await Promise.allSettled([
    withRpcRetry(() => getTokenSymbol(token)),
    withRpcRetry(() => getTokenDecimals(token)),
  ]);

  // A network failure on either read outranks a token fact on the other: the pair was not read,
  // and the honest report is that the read did not complete.
  for (const result of [symbolResult, decimalsResult]) {
    if (result.status === "rejected" && !isTokenFact(result.reason)) {
      return { kind: "unreachable", reason: reasonOf(result.reason) };
    }
  }

  if (symbolResult.status === "rejected") {
    return {
      kind: "not-erc20",
      reason: `symbol() did not answer as an ERC-20 string (${reasonOf(symbolResult.reason)})`,
    };
  }
  if (decimalsResult.status === "rejected") {
    return {
      kind: "not-erc20",
      reason: `decimals() did not answer as an ERC-20 uint8 (${reasonOf(decimalsResult.reason)})`,
    };
  }

  const symbol = normaliseTokenSymbol(symbolResult.value);
  if (symbol === null) {
    return { kind: "not-erc20", reason: "symbol() did not return a usable token symbol" };
  }

  const decimals = normaliseTokenDecimals(decimalsResult.value);
  if (decimals === null) {
    return { kind: "not-erc20", reason: "decimals() did not return a value in 0..36" };
  }

  return { kind: "read", symbol, decimals };
}
